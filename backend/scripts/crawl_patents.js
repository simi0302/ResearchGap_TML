// Offline patent knowledge-base expansion by citation snowballing (no AI, no API key).
//
//   node scripts/crawl_patents.js [--hops 2] [--max-fetch 40000] [--concurrency 4]
//                                 [--out data/patent_seed.jsonl.gz] [--fresh]
//
// The 2,799-patent GPSS corpus is a fixed, reproducible population for the statistics
// (Crowding / Regional / white-space). Prior-art retrieval for Novelty, however, gets better
// the more relevant patents it can search, so this script grows a separate patent knowledge
// base around that corpus:
//
// 1. SEEDS. Every corpus patent's public Google Patents page (/patent/<number>/en — the only
//    path robots.txt allows; the search endpoints are disallowed and never used).
// 2. EXPAND. Each page lists the patents it cites, the patents citing it (examiner and
//    applicant citations, family citations) and Google's "similar documents", each with a
//    number and title. A candidate is queued only if its title matches at least one feature of
//    the fixed SDN/NFV taxonomy (features.js) — a cheap first gate before any fetch.
// 3. VERIFY. Every queued candidate's own page is fetched and parsed by the same parser the live
//    backend uses (externalPriorArt.parsePatentPage: real title, abstract and publication date
//    or nothing), then knowledgeStore.normalize() applies the knowledge base's domain gate to
//    title + abstract (one core SDN/NFV/slicing feature, or two taxonomy features). Accepted
//    patents become seeds for the next hop.
//
// Output: gzipped JSONL (one knowledgeStore record per patent), loaded by knowledgeStore.js at
// startup next to the literature seed. Progress is checkpointed to <out>.state.json every 200
// fetches; re-running resumes (use --fresh to start over). A summary with the counts at every
// stage is written to data/patent_crawl_log.json so the expansion is auditable.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const features = require("../features");
const corpus = require("../corpus");
const { parsePatentPage } = require("../externalPriorArt");
const { normalize, patentBase } = require("../knowledgeStore");

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const HOPS = Number(arg("hops", 2));
const MAX_FETCH = Number(arg("max-fetch", 40000));
const CONCURRENCY = Number(arg("concurrency", 4));
const OUT = path.resolve(__dirname, "..", arg("out", "data/patent_seed.jsonl.gz"));
const STATE = `${OUT}.state.json`;
const LOG = path.resolve(__dirname, "..", "data", "patent_crawl_log.json");
const FRESH = args.includes("--fresh");
const SEED_LIMIT = Number(arg("seed-limit", 0)); // testing: only the first N corpus patents as seeds
const UA = "Mozilla/5.0 ResearchGap-TML (academic prototype; citation crawl)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const REF_ROWS = [
  "backwardReferences", "backwardReferencesOrig", "backwardReferencesFamily",
  "forwardReferences", "forwardReferencesOrig", "forwardReferencesFamily", "similarDocuments",
];
const ROW_RE = new RegExp(`<tr itemprop="(${REF_ROWS.join("|")})"[^>]*>([\\s\\S]*?)</tr>`, "g");

// Regex captures are V8 "sliced strings" that keep the whole page (hundreds of KB) alive; tens of
// thousands of queued numbers then hold every page ever fetched (the first full run ran out of a
// 4 GB heap). Every string that outlives the page is copied out first.
const flat = (s) => (s == null ? s : Buffer.from(String(s), "utf8").toString("utf8"));

function stripTags(s) {
  return String(s || "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
}

// Patent rows only (scholar rows in "similar documents" carry no publicationNumber).
function parseReferences(html) {
  const out = [];
  for (const m of String(html || "").matchAll(ROW_RE)) {
    const num = (m[2].match(/itemprop="publicationNumber">([A-Z]{2}[0-9A-Z]+)</) || [])[1];
    if (!num) continue;
    const title = stripTags((m[2].match(/itemprop="title">([\s\S]*?)<\/td>/) || [])[1]);
    out.push({ number: flat(num), relation: flat(m[1]), title: flat(title) });
  }
  return out;
}

function parseExtras(html) {
  // The page's own assignee is in the Dublin Core meta (the itemprop also appears in citation rows).
  const assignee = stripTags((html.match(/<meta name="DC\.contributor" content="([^"]*)" scheme="assignee">/) || [])[1]);
  const cpc = [...new Set([...String(html).matchAll(/<span itemprop="Code">([A-H]\d{2}[A-Z]\d{1,4}\/\d{2,6})<\/span>/g)].map((m) => m[1]))];
  const priority = (html.match(/itemprop="priorityDate"[^>]*datetime="(\d{4}-\d{2}-\d{2})"/) || html.match(/<time itemprop="priorityDate" datetime="(\d{4}-\d{2}-\d{2})"/) || [])[1];
  return { assignee: flat(assignee) || null, cpc: cpc.slice(0, 12).map(flat), priority_date: flat(priority) || null };
}

async function fetchPage(number, attempt = 0) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(`https://patents.google.com/patent/${number}/en`, { headers: { "User-Agent": UA }, signal: ctrl.signal });
    if (res.status === 404) return { status: 404 };
    if (res.status === 429 || res.status >= 500) {
      if (attempt >= 4) return { status: res.status };
      await sleep(5000 * 2 ** attempt); // back off politely
      return fetchPage(number, attempt + 1);
    }
    if (!res.ok) return { status: res.status };
    return { status: 200, html: await res.text() };
  } catch (err) {
    if (attempt >= 3) return { status: 0, error: err.message };
    await sleep(3000 * 2 ** attempt);
    return fetchPage(number, attempt + 1);
  } finally {
    clearTimeout(timer);
  }
}

function titleGate(title) {
  return features.matchFeaturesInText(title || "").size >= 1;
}

function loadState() {
  if (!FRESH && fs.existsSync(STATE)) return JSON.parse(fs.readFileSync(STATE, "utf-8"));
  const all = corpus.loadRawCorpus().map((p) => p.publication_number);
  const seeds = SEED_LIMIT ? all.slice(0, SEED_LIMIT) : all;
  return {
    started_at: new Date().toISOString(),
    queue: seeds.map((n) => ({ number: n, hop: 0, via: null })),
    seen: seeds.map((n) => patentBase(n)),
    fetched: 0,
    counts: { seed_pages: 0, references_seen: 0, title_gate_passed: 0, title_gate_failed: 0, fetched: 0, not_found: 0, fetch_failed: 0, unparseable: 0, domain_rejected: 0, accepted: 0, by_hop: {}, by_relation: {}, by_jurisdiction: {} },
    accepted: [],
  };
}

function save(state) {
  fs.writeFileSync(STATE, JSON.stringify(state));
  const lines = state.accepted.map((r) => JSON.stringify(r)).join("\n") + "\n";
  fs.writeFileSync(OUT, zlib.gzipSync(Buffer.from(lines, "utf-8")));
  const log = {
    method: "Citation snowballing from the 2,799-patent GPSS corpus over public Google Patents pages (/patent/ only, per robots.txt). Candidate titles gated by the SDN/NFV feature taxonomy; every accepted patent's own page fetched and parsed (title, abstract, publication date) and passed through the knowledge base's domain gate.",
    hops: HOPS,
    started_at: state.started_at,
    updated_at: new Date().toISOString(),
    queue_remaining: state.queue.length,
    ...state.counts,
  };
  fs.writeFileSync(LOG, JSON.stringify(log, null, 2));
}

(async () => {
  const state = loadState();
  const seen = new Set(state.seen);
  const corpusBases = new Set(corpus.loadRawCorpus().map((p) => patentBase(p.publication_number)));
  const c = state.counts;
  let lastSave = state.fetched;
  const t0 = Date.now();

  const work = async (job) => {
    const page = await fetchPage(job.number);
    state.fetched++;
    if (page.status === 404) return void c.not_found++;
    if (!page.html) return void c.fetch_failed++;
    c.fetched++;

    // Expand: queue in-domain references not seen yet.
    if (job.hop < HOPS) {
      for (const ref of parseReferences(page.html)) {
        c.references_seen++;
        const base = patentBase(ref.number);
        if (seen.has(base)) continue;
        seen.add(base);
        state.seen.push(base);
        if (!titleGate(ref.title)) {
          c.title_gate_failed++;
          continue;
        }
        c.title_gate_passed++;
        c.by_relation[ref.relation] = (c.by_relation[ref.relation] || 0) + 1;
        state.queue.push({ number: ref.number, hop: job.hop + 1, via: job.number, relation: ref.relation });
      }
    }
    if (job.hop === 0) return void c.seed_pages++;
    if (corpusBases.has(patentBase(job.number))) return;

    // Verify: real page fields + the knowledge base's own domain gate.
    const parsed = parsePatentPage(page.html, job.number);
    if (!parsed) return void c.unparseable++;
    const p = Object.fromEntries(Object.entries(parsed).map(([k, v]) => [k, typeof v === "string" ? flat(v) : v]));
    const extras = parseExtras(page.html);
    const rec = normalize(
      {
        ...p,
        type: "patent",
        date: p.publication_date,
        year: Number(p.publication_date.slice(0, 4)),
        url: `https://patents.google.com/patent/${p.publication_number}/en`,
        source: "Google Patents",
        query: `${job.relation || "ref"} of ${job.via}`,
        added_at: new Date().toISOString(),
      },
      "citation-crawl"
    );
    if (!rec) return void c.domain_rejected++;
    Object.assign(rec, { assignee: extras.assignee, cpc: extras.cpc, priority_date: extras.priority_date, hop: job.hop });
    state.accepted.push(rec);
    c.accepted++;
    c.by_hop[job.hop] = (c.by_hop[job.hop] || 0) + 1;
    c.by_jurisdiction[rec.jurisdiction] = (c.by_jurisdiction[rec.jurisdiction] || 0) + 1;
  };

  // Worker pool: each worker takes the next queued page; a worker that finds the queue empty
  // waits while others are still fetching (their pages may queue more), and stops when none are.
  let active = 0;
  const checkpoint = () => {
    if (state.fetched - lastSave < 200) return;
    lastSave = state.fetched;
    save(state);
    const rate = state.fetched / ((Date.now() - t0) / 1000);
    console.log(`${new Date().toISOString().slice(11, 19)} fetched ${state.fetched} · accepted ${c.accepted} · queue ${state.queue.length} · ${rate.toFixed(1)}/s · heap ${Math.round(process.memoryUsage().heapUsed / 1e6)} MB`);
  };
  const worker = async () => {
    for (;;) {
      if (state.fetched + active >= MAX_FETCH) return;
      const job = state.queue.shift();
      if (!job) {
        if (active === 0) return;
        await sleep(250);
        continue;
      }
      active++;
      try {
        await work(job);
      } catch (e) {
        console.error("job failed", job.number, e.message);
      } finally {
        active--;
      }
      checkpoint();
      await sleep(100); // spread requests out
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  save(state);
  console.log("done", JSON.stringify(c));
})();
