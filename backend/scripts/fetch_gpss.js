// Patent knowledge-base candidate set from TIPO's GPSS search API (same source as the corpus).
//
//   node scripts/fetch_gpss.js --probe            one 1-record request per query: prints hit counts only
//   node scripts/fetch_gpss.js [--max 25000]      fetch every query's hits, page by page
//                              [--until 20260603] publication-date upper bound (corpus extraction date)
//                              [--page 500]       records per request
//
// The key is read from GPSS_USER_CODE (backend/.env or the environment) and never printed.
// Output goes to data/gpss_patents.jsonl.gz + data/gpss_fetch_log.json. Nothing loads that file:
// the live knowledge base is unchanged until the team decides to switch.
//
// API limits (tiponet.tipo.gov.tw/gpss1/gpsskmc/gpssapi): office hours (Mon–Fri 08:00–18:00)
// 10,000 records per period; other times 30,000. Repeated invalid-key calls get the IP blocked,
// so any authentication error stops the run immediately — never retried.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const corpus = require("../corpus");
const { normalize, patentBase } = require("../knowledgeStore");

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const PROBE = args.includes("--probe");
const MAX = Number(arg("max", 25000));
const UNTIL = arg("until", "20260603");
const PAGE = Math.min(Number(arg("page", 500)), 1000);
const DATA = path.resolve(__dirname, "..", "data");
const OUT = path.join(DATA, "gpss_patents.jsonl.gz");
const LOG = path.join(DATA, "gpss_fetch_log.json");
const API = "https://tiponet.tipo.gov.tw/gpss1/gpsskmc/gpss_api";

function userCode() {
  if (process.env.GPSS_USER_CODE) return process.env.GPSS_USER_CODE.trim();
  const envFile = path.resolve(__dirname, "..", ".env");
  const m = fs.existsSync(envFile) && fs.readFileSync(envFile, "utf-8").match(/^GPSS_USER_CODE=(.+)$/m);
  if (!m) throw new Error("GPSS_USER_CODE not set (backend/.env)");
  return m[1].trim();
}

// Same three topics as the corpus. English for US/EP/WO and the English titles/abstracts GPSS
// carries for JP/KR/CN; Traditional + Simplified Chinese for TW and CN full text.
const QUERIES = [
  { id: "sdn", q: '"software defined network" or "software defined networking" or "software-defined network" or "software-defined networking"' },
  { id: "nfv", q: '"network function virtualization" or "network functions virtualization" or "network function virtualisation"' },
  { id: "slicing", q: '"network slicing" or "network slice" or "network slices"' },
  { id: "zh", q: "軟體定義網路 or 軟體定義網絡 or 软件定义网络 or 網路功能虛擬化 or 网络功能虚拟化 or 網路切片 or 網絡切片 or 网络切片" },
];
// Default = the corpus's own jurisdictions (US, EP, JP, TW); --dbs to widen (KPA,KPB,CNA,CNB,WO).
const DBS = arg("dbs", "TWA,TWB,USA,USB,EPA,EPB,JPA,JPB");

class StopError extends Error {}

async function call(code, q, qty, skip) {
  // GPSS parses the raw query string: spaces as %20 (not "+"), and ":" "," "/" left as is —
  // URLSearchParams-style encoding made it silently fall back to XML and 30 records.
  const enc = (v) => encodeURIComponent(v).replace(/%3A/gi, ":").replace(/%2C/gi, ",").replace(/%2F/gi, "/");
  const params = Object.entries({
    userCode: code, patDB: DBS, patAG: "A,B", patTY: "I", "TI/AB": q, ID: `:${UNTIL}`,
    expFld: "PN,AN,ID,AD,TI,PA,AB,IC,CS", expFmt: "json", expQty: String(qty), expSkip: String(skip),
  }).map(([k, v]) => `${k}=${enc(v)}`).join("&");
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${API}?${params}`, { signal: AbortSignal.timeout(120000) });
      const text = await res.text();
      let body;
      try {
        body = JSON.parse(text)["gpss-API"];
      } catch {
        throw new Error(`non-JSON response (HTTP ${res.status}): ${text.slice(0, 120)}`);
      }
      const msg = String(body.message || "");
      if (/userCode|IP blocked/i.test(msg)) throw new StopError(`GPSS refused the key: ${msg}`);
      if (/No record found/i.test(msg)) return { total: 0, items: [] };
      if (/expSkip too much/i.test(msg)) return { total: skip, items: [] };
      if (/Over download/i.test(msg)) throw new StopError(`GPSS download quota for this period reached: ${msg}`);
      if (body.status !== "success") throw new StopError(`GPSS error: ${msg || body.status}`);
      const items = [].concat(body.patent?.patentcontent || []);
      return { total: Number(body["total-rec"]) || 0, items };
    } catch (e) {
      if (e instanceof StopError || attempt >= 2) throw e;
      await new Promise((r) => setTimeout(r, 5000 * (attempt + 1)));
    }
  }
}

const list = (x) => [].concat(x || []);
const uniq = (xs) => [...new Set(xs.filter(Boolean).map((x) => String(x).trim()))];
const decode = (s) => (s ? String(s).replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim() : s);
const ymd = (d) => (/^\d{8}$/.test(d || "") ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}` : null);

function toRecord(pc, queryId) {
  const number = pc["publication-reference"]?.["doc-number"];
  const date = ymd(pc["publication-reference"]?.date);
  if (!number || !date) return null;
  const t = pc["patent-title"] || {};
  const abstract = list(pc.abstract?.p).join(" ");
  const applicants = list(pc.parties?.applicants?.applicant);
  // English title first so the English feature taxonomy can match; keep the original too.
  const title = t["english-title"] || t.title;
  const rec = normalize(
    {
      type: "patent",
      title,
      abstract,
      date,
      year: Number(date.slice(0, 4)),
      publication_number: number,
      jurisdiction: (String(number).match(/^[A-Z]{2}/) || [""])[0],
      // GPSS has no stable per-document URL; the public Google Patents page of the same number
      // is linked for reading (the record itself comes from GPSS).
      url: `https://patents.google.com/patent/${number}/en`,
      source: "GPSS",
      query: `gpss:${queryId}`,
      added_at: new Date().toISOString(),
    },
    "gpss"
  );
  if (!rec) return null;
  Object.assign(rec, {
    title_original: t.title && t.title !== title ? t.title : undefined,
    gpss_database: pc["@database"],
    application_number: pc["application-reference"]?.["doc-number"],
    filing_date: ymd(pc["application-reference"]?.date),
    assignee: decode(applicants.map((a) => a["english-name"] || a.name).filter(Boolean)[0]) || null,
    ipc: uniq(list(pc["classifications-ipc"]?.ipc).map((x) => x.keyValue)),
    cpc: uniq(list(pc["classifications-cpc"]?.cpc).map((x) => x.keyValue)),
  });
  return rec;
}

async function main() {
  const code = userCode();
  if (PROBE) {
    for (const { id, q } of QUERIES) {
      const r = await call(code, q, 1, 0);
      const first = r.items[0];
      console.log(`${id.padEnd(8)} hits ${r.total}` + (first ? ` · e.g. ${first["publication-reference"]?.["doc-number"]} ${(first["patent-title"]?.["english-title"] || first["patent-title"]?.title || "").slice(0, 70)}` : ""));
    }
    return;
  }

  const corpusBases = new Set(corpus.loadRawCorpus().map((p) => patentBase(p.publication_number)));
  const kbBases = new Set();
  const seedFile = path.join(DATA, "patent_seed.jsonl.gz");
  if (fs.existsSync(seedFile)) {
    for (const line of zlib.gunzipSync(fs.readFileSync(seedFile)).toString("utf-8").split("\n")) {
      if (line.trim()) kbBases.add(patentBase(JSON.parse(line).publication_number));
    }
  }

  const c = { requested: 0, returned: 0, in_corpus: 0, duplicate: 0, domain_rejected: 0, accepted: 0, also_in_citation_kb: 0, by_query: {}, by_jurisdiction: {}, by_year: {} };
  const accepted = new Map();
  let stopped = null;
  try {
    for (const { id, q } of QUERIES) {
      let skip = 0, total = Infinity;
      c.by_query[id] = { hits: 0, accepted: 0 };
      while (skip < total && c.returned < MAX) {
        const r = await call(code, q, Math.min(PAGE, MAX - c.returned), skip);
        c.requested++;
        total = r.total;
        c.by_query[id].hits = total;
        if (!r.items.length) break;
        skip += r.items.length;
        c.returned += r.items.length;
        for (const pc of r.items) {
          const rec = toRecord(pc, id);
          if (!rec) { c.domain_rejected++; continue; }
          const base = patentBase(rec.publication_number);
          if (corpusBases.has(base)) { c.in_corpus++; continue; }
          if (accepted.has(base)) { c.duplicate++; continue; }
          accepted.set(base, rec);
          c.accepted++;
          c.by_query[id].accepted++;
          if (kbBases.has(base)) c.also_in_citation_kb++;
          c.by_jurisdiction[rec.jurisdiction] = (c.by_jurisdiction[rec.jurisdiction] || 0) + 1;
          c.by_year[rec.year] = (c.by_year[rec.year] || 0) + 1;
        }
        console.log(`${id} ${skip}/${total} · accepted ${c.accepted} · returned ${c.returned}`);
      }
    }
  } catch (e) {
    if (!(e instanceof StopError)) throw e;
    stopped = e.message;
    console.error(stopped);
  }

  const lines = [...accepted.values()].map((r) => JSON.stringify(r)).join("\n") + "\n";
  fs.writeFileSync(OUT, zlib.gzipSync(Buffer.from(lines, "utf-8")));
  fs.writeFileSync(LOG, JSON.stringify({
    method: "TIPO GPSS search API (same source as the 2,799-patent corpus): title/abstract keyword queries for SDN, NFV and network slicing over TW/US/EP/JP/KR/CN/WO invention patents published on or before the corpus extraction date; each hit passed through the knowledge base's domain gate; corpus patents and duplicates removed.",
    run_at: new Date().toISOString(), until: UNTIL, databases: DBS, queries: QUERIES, stopped, counts: c,
  }, null, 2));
  console.log(JSON.stringify(c, null, 2));
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
module.exports = { toRecord };
