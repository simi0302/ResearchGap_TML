// Offline knowledge-base expansion: an AI-planned, backend-verified literature crawl.
//
//   node scripts/crawl.js [--max-queries 120] [--pages 2] [--no-ai] [--out data/knowledge_seed.jsonl.gz]
//                         [--sources openalex,arxiv,crossref] [--plan-from data/crawl_plan.json] [--merge]
//   --plan-from reuses a saved plan instead of asking the model again; --merge starts from the
//   records already in --out, so a second pass (e.g. another source) only adds new ones.
//
// 1. PLAN (AI). gpt-4.1-mini is given the fixed SDN/NFV feature taxonomy (features.js) and the
//    corpus's curated IPC groups and asked for search queries that cover each sub-topic and the
//    cross-combinations between them. The plan is saved to data/crawl_plan.json so every crawl is
//    auditable. With --no-ai (or no Azure credentials) a deterministic plan is built from the
//    taxonomy alone.
// 2. FETCH (no AI). Each query is sent to OpenAlex (title+abstract search, CC0 metadata, abstract
//    reconstructed from its inverted index; OPENALEX_API_KEY recommended — keyless use shares a
//    small daily budget), arXiv (CC0 metadata) and Crossref (bibliographic metadata, abstracts
//    when the publisher deposited one).
// 3. VERIFY (no AI). knowledgeStore.normalize() keeps only records with a real title and year
//    whose own title/abstract matches at least one taxonomy feature, and de-duplicates by DOI /
//    arXiv id / title. The model never decides what is stored.
//
// The result is written as gzipped JSONL and loaded by knowledgeStore.js at startup.
require("dotenv").config({ path: require("path").join(__dirname, "..", ".env") });
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const features = require("../features");
const { KnowledgeStore } = require("../knowledgeStore");

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const MAX_QUERIES = Number(arg("max-queries", 120));
const PAGES = Number(arg("pages", 2));
const USE_AI = !args.includes("--no-ai");
const SOURCES = new Set(String(arg("sources", "openalex,arxiv")).split(","));
const PLAN_FROM = arg("plan-from", null);
const MERGE = args.includes("--merge");
const OA_KEY = process.env.OPENALEX_API_KEY ? `&api_key=${encodeURIComponent(process.env.OPENALEX_API_KEY)}` : "";
const OUT = path.resolve(__dirname, "..", arg("out", "data/knowledge_seed.jsonl.gz"));
const PLAN_OUT = path.resolve(__dirname, "..", "data", "crawl_plan.json");
const MAILTO = "researchgap-tool@example.org";
const YEARS = "2008-2026";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const IPC_TOPICS = [
  "data switching networks", "routing and path selection", "network management", "traffic control and QoS",
  "network access selection", "virtualization and scheduling", "network security", "wireless resource management",
  "wireless monitoring and testing",
];

function deterministicPlan() {
  const labels = features.FEATURE_DEFS.map((f) => f.label.replace(/\s*\(.*?\)\s*/g, " ").trim());
  const qs = [];
  for (const f of features.FEATURE_DEFS) qs.push(f.phrases[0] || f.acronyms[0]);
  const core = ["software-defined networking", "network function virtualization", "network slicing"];
  for (const c of core) for (const l of labels) if (!l.toLowerCase().includes(c.split(" ")[0])) qs.push(`${c} ${l.toLowerCase()}`);
  return [...new Set(qs)].map((q) => ({ query: q, why: "taxonomy cross-product" }));
}

async function aiPlan() {
  const { AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_API_KEY, AZURE_OPENAI_DEPLOYMENT, AZURE_OPENAI_API_VERSION = "2024-06-01" } = process.env;
  if (!AZURE_OPENAI_ENDPOINT || !AZURE_OPENAI_API_KEY || !AZURE_OPENAI_DEPLOYMENT) throw new Error("no Azure credentials");
  const taxonomy = features.FEATURE_DEFS.map((f) => `- ${f.label}: ${[...f.phrases.slice(0, 4), ...f.acronyms.slice(0, 3)].join(", ")}`).join("\n");
  const prompt = `You plan a literature crawl for a patent white-space tool scoped to SDN / NFV / network slicing.
Fixed feature taxonomy (the crawl must stay inside it):
${taxonomy}
Patent classification topics in the corpus: ${IPC_TOPICS.join("; ")}.

Return JSON {"queries":[{"query":"...","why":"..."}]} with ${MAX_QUERIES} distinct English search queries (2-6 words each) for an academic search engine:
- every taxonomy feature appears in several queries;
- most queries combine two features (e.g. "network slicing digital twin", "SFC P4 data plane");
- include established topics and emerging ones (6G, LLM / agentic network management, intent-based networking, O-RAN xApps, zero trust);
- no duplicates, no generic queries like "networking".`;
  const url = `${AZURE_OPENAI_ENDPOINT.replace(/\/$/, "")}/openai/deployments/${AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=${AZURE_OPENAI_API_VERSION}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "api-key": AZURE_OPENAI_API_KEY },
    body: JSON.stringify({ messages: [{ role: "user", content: prompt }], temperature: 0.4, max_tokens: 6000, response_format: { type: "json_object" } }),
  });
  if (!res.ok) throw new Error(`Azure ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  const parsed = JSON.parse(data.choices[0].message.content);
  const seen = new Set();
  return (parsed.queries || [])
    .map((q) => ({ query: String(q.query || "").trim().slice(0, 80), why: String(q.why || "").slice(0, 160) }))
    .filter((q) => q.query.split(/\s+/).length >= 1 && !seen.has(q.query.toLowerCase()) && seen.add(q.query.toLowerCase()));
}

function abstractFromInverted(inv) {
  if (!inv) return "";
  const words = [];
  for (const [w, positions] of Object.entries(inv)) for (const p of positions) words[p] = w;
  return words.filter(Boolean).join(" ");
}

async function fetchJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": `ResearchGap-TML crawler (mailto:${MAILTO})` }, signal: AbortSignal.timeout(30000) });
      if (res.status === 429) {
        await sleep(3000 * (i + 1));
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (i === tries - 1) throw err;
      await sleep(1500 * (i + 1));
    }
  }
  return null;
}

async function openAlex(query) {
  const out = [];
  let cursor = "*";
  for (let page = 0; page < PAGES && cursor; page++) {
    const url =
      `https://api.openalex.org/works?filter=title_and_abstract.search:${encodeURIComponent(query)},publication_year:${YEARS},has_abstract:true` +
      `&select=id,doi,title,publication_year,publication_date,abstract_inverted_index,authorships,cited_by_count,primary_location,type` +
      `&per_page=200&cursor=${encodeURIComponent(cursor)}&mailto=${MAILTO}${OA_KEY}`;
    const data = await fetchJson(url);
    if (!data) break;
    for (const w of data.results || []) {
      out.push({
        type: "paper",
        title: w.title,
        abstract: abstractFromInverted(w.abstract_inverted_index),
        year: w.publication_year,
        date: w.publication_date,
        venue: w.primary_location?.source?.display_name || null,
        url: w.doi || w.id,
        doi: w.doi,
        source: "OpenAlex",
        authors: (w.authorships || []).map((a) => a.author?.display_name).filter(Boolean),
        cited_by: w.cited_by_count,
        query,
      });
    }
    cursor = data.meta?.next_cursor || null;
    await sleep(150);
  }
  return out;
}

async function arxiv(query) {
  const q = query.split(/\s+/).map((w) => `all:${encodeURIComponent(w)}`).join("+AND+");
  const url = `https://export.arxiv.org/api/query?search_query=${q}&start=0&max_results=100&sortBy=relevance`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) }); // a hung request must not stall the crawl
  if (!res.ok) throw new Error(`arXiv ${res.status}`);
  const xml = await res.text();
  return xml
    .split("<entry>")
    .slice(1)
    .map((e) => {
      const get = (tag) => e.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`))?.[1]?.replace(/\s+/g, " ").trim() || "";
      const published = get("published");
      return {
        type: "paper",
        title: get("title"),
        abstract: get("summary"),
        year: Number(published.slice(0, 4)),
        date: published.slice(0, 10),
        venue: "arXiv preprint",
        url: get("id").replace(/^http:/, "https:"),
        doi: e.match(/<arxiv:doi[^>]*>([^<]+)</)?.[1] || null,
        source: "arXiv",
        authors: [...e.matchAll(/<name>([^<]+)<\/name>/g)].map((m) => m[1]),
        query,
      };
    });
}

async function crossref(query) {
  const url =
    `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(query)}&rows=200` +
    `&filter=from-pub-date:2008-01-01,type:journal-article,type:proceedings-article,type:posted-content` +
    `&select=DOI,title,abstract,issued,container-title,author,is-referenced-by-count,type&mailto=${MAILTO}`;
  const data = await fetchJson(url);
  return (data?.message?.items || []).map((w) => {
    const parts = w.issued?.["date-parts"]?.[0] || [];
    return {
      type: "paper",
      title: Array.isArray(w.title) ? w.title[0] : w.title,
      abstract: w.abstract || "",
      year: parts[0],
      date: parts.length === 3 ? `${parts[0]}-${String(parts[1]).padStart(2, "0")}-${String(parts[2]).padStart(2, "0")}` : null,
      venue: w["container-title"]?.[0] || null,
      url: w.DOI ? `https://doi.org/${w.DOI}` : null,
      doi: w.DOI,
      source: "Crossref",
      authors: (w.author || []).map((a) => [a.given, a.family].filter(Boolean).join(" ")).filter(Boolean),
      cited_by: w["is-referenced-by-count"],
      query,
    };
  });
}

// Atomic write (temp file + rename) so a crash mid-write never leaves a truncated seed.
function writeSeed(store) {
  const lines = store.docs.map(({ item }) => JSON.stringify(item)).join("\n") + "\n";
  fs.writeFileSync(`${OUT}.tmp`, zlib.gzipSync(lines, { level: 9 }));
  fs.renameSync(`${OUT}.tmp`, OUT);
}

(async () => {
  let plan;
  let planner = "deterministic";
  if (PLAN_FROM) {
    const saved = JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", PLAN_FROM), "utf-8"));
    plan = saved.queries;
    planner = `${saved.planner} (reused ${saved.created_at})`;
  } else if (USE_AI) {
    try {
      plan = await aiPlan();
      planner = `ai:${process.env.AZURE_OPENAI_DEPLOYMENT}`;
    } catch (err) {
      console.warn("AI planning failed, falling back to deterministic plan:", err.message);
    }
  }
  if (!plan || !plan.length) plan = deterministicPlan();
  plan = plan.slice(0, MAX_QUERIES);
  if (!PLAN_FROM) fs.writeFileSync(PLAN_OUT, JSON.stringify({ planner, created_at: new Date().toISOString(), queries: plan }, null, 2));
  console.log(`plan: ${plan.length} queries (${planner})`);

  // A fresh, non-persistent store is the verifier + de-duplicator (seed origin, no learned file).
  const store = new KnowledgeStore({ seedPath: MERGE && fs.existsSync(OUT) ? OUT : null, dir: null, persist: false });
  store.load();
  if (MERGE) console.log(`merge: starting from ${store.docs.length} existing records`);
  const log = [];
  for (const [i, { query }] of plan.entries()) {
    const row = { query, added: 0, rejected: 0, dup: 0 };
    const fetchers = { openalex: openAlex, arxiv, crossref };
    for (const src of ["openalex", "arxiv", "crossref"]) {
      if (!SOURCES.has(src)) continue;
      try {
        const items = await fetchers[src](query);
        row[src] = items.length;
        const r = store.addMany(items, { origin: "seed" });
        row.added += r.added;
        row.rejected += r.rejected;
        row.dup += r.skipped_duplicate;
      } catch (err) {
        row[`${src}_error`] = err.message;
      }
    }
    if (SOURCES.has("arxiv")) await sleep(3100); // arXiv asks for >= 3 s between calls
    else await sleep(300);
    log.push(row);
    if ((i + 1) % 10 === 0) writeSeed(store); // checkpoint: an interrupted crawl keeps what it has
    const fetched = [...SOURCES].map((src) => `${src} ${row[src] ?? (row[`${src}_error`] ? "ERR" : 0)}`).join(", ");
    console.log(`[${i + 1}/${plan.length}] ${query}: +${row.added} (${fetched}, dup ${row.dup}, rejected ${row.rejected}) total ${store.docs.length}`);
  }

  writeSeed(store);
  const stats = store.stats();
  const logPath = path.resolve(__dirname, "..", "data", "crawl_log.json");
  const previous = MERGE && fs.existsSync(logPath) ? JSON.parse(fs.readFileSync(logPath, "utf-8")) : null;
  const passes = [...(previous?.passes || (previous ? [{ planner: previous.planner, finished_at: previous.finished_at, per_query: previous.per_query }] : [])), { planner, sources: [...SOURCES], finished_at: new Date().toISOString(), per_query: log }];
  fs.writeFileSync(logPath, JSON.stringify({ totals: { stored: stats.total, by_source: stats.by_source, by_year: stats.by_year }, passes }, null, 2));
  console.log(`done: ${stats.total} records → ${OUT} (${(fs.statSync(OUT).size / 1e6).toFixed(1)} MB gz)`);
})();
