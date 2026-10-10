// Topic landscape — the agent's answer to "how crowded is <topic>?" without an uploaded paper.
//
// A general chatbot answers that question from memory, in prose, with numbers nobody can check.
// This tool answers it from data, deterministically: the same query always returns the same
// numbers, and every number is a count over a named population.
//   - patents: the fixed 2,799-patent GPSS corpus, matched with the search bar's own concept
//     matcher (queryMatch.js — synonyms, Chinese ↔ English), counted by year / jurisdiction /
//     IPC group, applicant concentration as HHI;
//   - papers: the persistent knowledge base (knowledgeStore.js), matched the same way;
//   - the paper-to-patent ratio over the last five years, the signal behind "research is
//     growing faster than patent filings" (the Temporal idea in POS).
// Optional cutoffYear applies the 基準日 rule: nothing after Dec 31 of that year is counted.
const corpus = require("./corpus");
const QueryMatch = require("./queryMatch");
const knowledgeStore = require("./knowledgeStore");

const JURISDICTIONS = ["US", "EP", "JP", "TW", "SG", "MY"];

function hhiOf(names) {
  const counts = new Map();
  for (const n of names) counts.set(n, (counts.get(n) || 0) + 1);
  const total = names.length;
  let hhi = 0;
  for (const c of counts.values()) hhi += ((c / total) * 100) ** 2;
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([name, n]) => ({ name, patents: n, share_pct: Math.round((n / total) * 1000) / 10 }));
  return { hhi: Math.round(hhi), top };
}

function concentrationLabel(hhi) {
  // U.S. DOJ/FTC Horizontal Merger Guidelines bands (1992: 1000–1800 moderately, >1800 highly
  // concentrated; the 2023 Merger Guidelines keep >1800 as highly concentrated).
  if (hhi > 1800) return "highly concentrated";
  if (hhi >= 1000) return "moderately concentrated";
  return "unconcentrated";
}

function topicLandscape(query, { cutoffYear } = {}) {
  const q = String(query || "").trim().slice(0, 100);
  const concepts = QueryMatch.parseQuery(q);
  if (!concepts.length) return { error: "Empty or unusable query." };
  const cutoffDate = cutoffYear ? `${cutoffYear}-12-31` : null;
  const lastYear = cutoffYear || new Date().getFullYear() - 1;
  const years = [];
  for (let y = lastYear - 9; y <= lastYear; y++) years.push(y);

  // --- patents (fixed corpus) ---
  const all = corpus.loadRawCorpus();
  const population = cutoffDate ? corpus.filterByCutoff(all, cutoffDate) : all;
  const hits = population
    .map((p) => ({ p, s: QueryMatch.scorePatent(concepts, p, q) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || String(b.p.publication_date).localeCompare(String(a.p.publication_date)));
  const patents = hits.map((x) => x.p);
  const byJur = Object.fromEntries(JURISDICTIONS.map((j) => [j, patents.filter((p) => p.jurisdiction === j).length]));
  const patentsByYear = Object.fromEntries(years.map((y) => [y, patents.filter((p) => Number(String(p.publication_date).slice(0, 4)) === y).length]));
  const ipcCounts = new Map();
  for (const p of patents) {
    const g = p.ipc.length ? corpus.ipcMainGroup(p.ipc[0]) : null;
    if (g) ipcCounts.set(g, (ipcCounts.get(g) || 0) + 1);
  }
  const topIpc = [...ipcCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([group, n]) => ({ ipc: group, label: corpus.representativeLabel(group), patents: n }));
  const applicants = patents.map((p) => p.assignees[0] || p.company_name || "unknown");
  const conc = patents.length ? hhiOf(applicants) : { hhi: null, top: [] };

  // --- papers (knowledge base) ---
  const kb = knowledgeStore.getStore().load();
  const papers = [];
  for (const { item } of kb.docs) {
    if (item.type !== "paper") continue;
    if (cutoffYear && item.year > cutoffYear) continue;
    if (QueryMatch.scorePatent(concepts, item, q) > 0) papers.push(item);
  }
  const papersByYear = Object.fromEntries(years.map((y) => [y, papers.filter((p) => p.year === y).length]));
  const recent = years.slice(-5);
  const sum = (obj, ys) => ys.reduce((s, y) => s + (obj[y] || 0), 0);
  const recentPapers = sum(papersByYear, recent);
  const recentPatents = sum(patentsByYear, recent);
  const prior = years.slice(-10, -5);
  const growth = (obj) => {
    const a = sum(obj, prior);
    const b = sum(obj, recent);
    return a ? Math.round(((b - a) / a) * 1000) / 10 : null;
  };
  const topPapers = papers
    .slice()
    .sort((a, b) => (b.cited_by || 0) - (a.cited_by || 0) || b.year - a.year)
    .slice(0, 5)
    .map((p) => ({ title: p.title, year: p.year, venue: p.venue, url: p.url, cited_by: p.cited_by ?? null, source: p.source }));

  return {
    query: q,
    understood_as: concepts.map((c) => c.label),
    cutoff_year: cutoffYear || null,
    patents: {
      population: `GPSS corpus, N=${all.length}, extracted 2026-06-03${cutoffDate ? `, ${population.length} published on/before ${cutoffDate}` : ""}`,
      matched: patents.length,
      share_of_corpus_pct: population.length ? Math.round((patents.length / population.length) * 1000) / 10 : 0,
      by_jurisdiction: byJur,
      by_year: patentsByYear,
      growth_last5_vs_prev5_pct: growth(patentsByYear),
      top_ipc_groups: topIpc,
      applicant_hhi: conc.hhi,
      applicant_concentration: conc.hhi == null ? null : concentrationLabel(conc.hhi),
      top_applicants: conc.top,
      examples: patents.slice(0, 5).map((p) => ({ publication_number: p.publication_number, title: p.title, year: Number(String(p.publication_date).slice(0, 4)), jurisdiction: p.jurisdiction, url: `https://patents.google.com/patent/${p.publication_number}/en` })),
    },
    papers: {
      population: `ResearchGap knowledge base, N=${kb.docs.length} (papers + verified patents, grows with every search)`,
      matched: papers.length,
      by_year: papersByYear,
      growth_last5_vs_prev5_pct: growth(papersByYear),
      most_cited: topPapers,
    },
    research_to_patent_ratio_last5: recentPatents ? Math.round((recentPapers / recentPatents) * 100) / 100 : null,
    reading_guide:
      "matched = documents containing every concept of the query (synonyms count). HHI uses each patent's first applicant (U.S. DOJ/FTC merger-guideline bands: 1000–1800 moderately, >1800 highly concentrated). A high research-to-patent ratio with growing papers suggests academic activity that patent filings have not caught up with — a candidate white space, not a conclusion.",
  };
}

module.exports = { topicLandscape, hhiOf, concentrationLabel };
