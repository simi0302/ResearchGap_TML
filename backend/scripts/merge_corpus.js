// Merges the original 2,799-patent GPSS corpus with the 3,457 patents fetched later from the
// GPSS API (data/gpss_patents.jsonl.gz, scripts/fetch_gpss.js) into ONE de-duplicated corpus.
// Both come from GPSS with the same countries and the same 2026-06-03 publication cutoff, so
// they are one population; keeping them apart made the assistant quote "2,799" while the site
// showed more. No AI, no network — a pure file transform, re-runnable.
//
//   node scripts/merge_corpus.js
//
// Reads  data/patents_corpus_2799.json  (the original corpus; created from data/patents.json
//                                         on the first run so re-runs never merge twice)
//        data/gpss_patents.jsonl.gz
// Writes data/patents.json               (backend copy, all fields + `batch`)
//        ../data/patents.json            (site copy, the fields the browser uses, abstract ≤ 400)
//        data/merge_log.json
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const DATA = path.join(__dirname, "..", "data");
const ORIGINAL = path.join(DATA, "patents_corpus_2799.json");
const BACKEND_OUT = path.join(DATA, "patents.json");
const SITE_OUT = path.join(__dirname, "..", "..", "data", "patents.json");
const GPSS = path.join(DATA, "gpss_patents.jsonl.gz");

// "US08448238B1" / "US8448238B1" -> "US8448238": kind code stripped as in knowledgeStore.patentBase,
// plus the zero padding GPSS adds to 7-digit US grants.
function baseNumber(n) {
  return String(n || "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/[A-Z]\d?$/, "").replace(/^([A-Z]{2})0+/, "$1");
}

if (!fs.existsSync(ORIGINAL)) fs.copyFileSync(BACKEND_OUT, ORIGINAL);
const original = JSON.parse(fs.readFileSync(ORIGINAL, "utf-8"));
const gpss = zlib
  .gunzipSync(fs.readFileSync(GPSS))
  .toString("utf-8")
  .split("\n")
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l));

// The original corpus lists 226 EP applications twice (A1 publication and B1 grant of the same
// application number). They count once, kept as the earlier publication, which is the date that
// matters for prior art.
const seen = new Map(); // base number -> index in merged
const merged = [];
let dupInCorpus = 0;
for (const p of original) {
  const b = baseNumber(p.publication_number);
  if (seen.has(b)) {
    dupInCorpus++;
    const i = seen.get(b);
    if ((p.publication_date || "9") < (merged[i].publication_date || "9")) merged[i] = { ...p, batch: "corpus_2799" };
    continue;
  }
  seen.set(b, merged.length);
  merged.push({ ...p, batch: "corpus_2799" });
}
let dupGpss = 0;
for (const r of gpss) {
  const b = baseNumber(r.publication_number);
  if (seen.has(b)) { dupGpss++; continue; }
  seen.set(b, merged.length);
  const assignees = r.assignee ? [String(r.assignee).trim()] : [];
  merged.push({
    publication_number: r.publication_number,
    title: r.title || "",
    abstract: r.abstract || "",
    jurisdiction: r.jurisdiction,
    company_name: assignees[0] || "",
    ipc: Array.isArray(r.ipc) ? r.ipc : [],
    cpc: Array.isArray(r.cpc) ? r.cpc : [],
    assignees,
    publication_date: r.date || null,
    filing_date: r.filing_date || null,
    category: null,
    batch: "gpss_api_20261012",
  });
}

fs.writeFileSync(BACKEND_OUT, JSON.stringify(merged));
const SITE_FIELDS = ["publication_number", "title", "abstract", "jurisdiction", "company_name", "ipc", "assignees", "publication_date"];
const site = merged.map((p) => {
  const o = {};
  for (const k of SITE_FIELDS) o[k] = k === "abstract" ? String(p.abstract || "").slice(0, 400) : p[k];
  return o;
});
fs.writeFileSync(SITE_OUT, JSON.stringify(site));

const byJur = {};
for (const p of merged) byJur[p.jurisdiction] = (byJur[p.jurisdiction] || 0) + 1;
const log = {
  merged_at: new Date().toISOString(),
  original: original.length,
  gpss_api: gpss.length,
  duplicates_removed: { within_original_ep_a1_b1: dupInCorpus, gpss_already_in_corpus: dupGpss },
  total: merged.length,
  by_jurisdiction: byJur,
  publication_cutoff: "2026-06-03",
};
fs.writeFileSync(path.join(DATA, "merge_log.json"), JSON.stringify(log, null, 2));
console.log(JSON.stringify(log, null, 2));
