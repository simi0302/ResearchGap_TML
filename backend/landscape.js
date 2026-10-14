// Topic landscape — the agent's answer to "how crowded is <topic>?" without an uploaded paper.
//
// A general chatbot answers that question from memory, in prose, with numbers nobody can check.
// This tool answers it from data, deterministically: the same query always returns the same
// numbers, and every number is a count over a named population.
//   - patents: the fixed 2,799-patent GPSS corpus, matched with the search bar's own concept
//     matcher (queryMatch.js — synonyms, Chinese ↔ English), counted by year / jurisdiction /
//     IPC group, applicant concentration as HHI;
//   - papers: the persistent knowledge base (knowledgeStore.js), matched the same way;
//   - patents_kb: the knowledge base's patents (fetched from the same GPSS source as the corpus,
//     same jurisdictions, minus the corpus itself, plus patents verified during live scoring).
//     Reported separately: the corpus figures stay the reproducible reference population;
//   - the paper-to-patent ratio over the last five years, the signal behind "research is
//     growing faster than patent filings" (the Temporal idea in POS).
// Optional cutoffYear applies the 基準日 rule: nothing after Dec 31 of that year is counted.
const corpus = require("./corpus");
const QueryMatch = require("./queryMatch");
const knowledgeStore = require("./knowledgeStore");
const literature = require("./literature");

const JURISDICTIONS = ["US", "EP", "JP", "TW", "SG", "MY"];

// Both functions below scan the whole knowledge base (tens of thousands of records), and the
// Azure free tier has a daily CPU quota, so results are kept for 10 minutes per argument set.
// Write-back can make a cached answer at most that much behind the live knowledge base.
const CACHE_TTL_MS = 10 * 60 * 1000;
const CACHE_MAX = 300;
const cache = new Map();
function cached(key, compute) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const value = compute();
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { at: Date.now(), value });
  return value;
}
function _clearCache() {
  cache.clear();
}

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

function topicLandscape(query, opts = {}) {
  return cached(JSON.stringify(["landscape", query, opts.cutoffYear || null]), () => computeLandscape(query, opts));
}

function computeLandscape(query, { cutoffYear } = {}) {
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
  // company_name is the clean applicant; the split assignees list breaks names like "AT&T".
  const applicants = patents.map((p) => p.company_name || p.assignees[0] || "unknown");
  const conc = patents.length ? hhiOf(applicants) : { hhi: null, top: [] };

  // --- papers and patents (knowledge base) ---
  const kb = knowledgeStore.getStore().load();
  const papers = [];
  const kbPatents = [];
  let kbPatentTotal = 0;
  for (const { item } of kb.docs) {
    if (item.type === "patent") kbPatentTotal++;
    if (cutoffYear && item.year > cutoffYear) continue;
    if (QueryMatch.scorePatent(concepts, item, q) <= 0) continue;
    if (item.type === "paper") papers.push(item);
    else if (item.type === "patent") kbPatents.push(item);
  }
  const kbPatentsByYear = Object.fromEntries(years.map((y) => [y, kbPatents.filter((p) => p.year === y).length]));
  const kbJur = {};
  for (const p of kbPatents) {
    const j = p.jurisdiction || String(p.publication_number || "").slice(0, 2);
    kbJur[j] = (kbJur[j] || 0) + 1;
  }
  const kbWithAssignee = kbPatents.filter((p) => p.assignee);
  const kbConc = kbWithAssignee.length ? hhiOf(kbWithAssignee.map((p) => p.assignee)) : { hhi: null, top: [] };
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
    patents_kb: {
      population: `ResearchGap patent knowledge base, N=${kbPatentTotal} (fetched from GPSS, the corpus's own source, beyond the corpus; not the scoring population)`,
      matched: kbPatents.length,
      by_year: kbPatentsByYear,
      growth_last5_vs_prev5_pct: growth(kbPatentsByYear),
      by_jurisdiction: Object.fromEntries(Object.entries(kbJur).sort((a, b) => b[1] - a[1]).slice(0, 8)),
      applicant_hhi: kbConc.hhi,
      applicant_concentration: kbConc.hhi == null ? null : concentrationLabel(kbConc.hhi),
      top_applicants: kbConc.top,
      examples: kbPatents
        .slice()
        .sort((a, b) => String(b.date || b.year).localeCompare(String(a.date || a.year)))
        .slice(0, 5)
        .map((p) => ({ publication_number: p.publication_number, title: p.title, year: p.year, jurisdiction: p.jurisdiction, assignee: p.assignee || null, url: p.url })),
    },
    research_to_patent_ratio_last5: recentPatents ? Math.round((recentPapers / recentPatents) * 100) / 100 : null,
    reading_guide:
      "matched = documents containing every concept of the query (synonyms count). HHI uses each patent's first applicant (U.S. DOJ/FTC merger-guideline bands: 1000–1800 moderately, >1800 highly concentrated). A high research-to-patent ratio with growing papers suggests academic activity that patent filings have not caught up with — a candidate white space, not a conclusion.",
  };
}

// The query as an OpenAlex boolean expression: each concept's English variants OR-ed (quoted if
// multi-word), concepts AND-ed — the same "every concept must appear" rule as the patent matcher.
function openAlexQuery(concepts) {
  const parts = [];
  for (const c of concepts) {
    const vs = [...new Set(c.variants.filter((v) => /^[ -~]+$/.test(v)).map((v) => v.replace(/["()]/g, "").trim()).filter(Boolean))].slice(0, 4);
    if (!vs.length) continue;
    const terms = vs.map((v) => (/\s/.test(v) ? `"${v}"` : v));
    parts.push(terms.length > 1 ? `(${terms.join(" OR ")})` : terms[0]);
  }
  return parts.join(" AND ");
}

// topicLandscape plus the topic's paper counts over all of OpenAlex. Papers in the knowledge base
// are a crawled sample, so comparing their count with the (near-complete) patent corpus would
// make patents look more numerous than papers; the research-to-patent ratio therefore uses the
// OpenAlex counts whenever they are available.
async function topicLandscapeWithWorld(query, opts = {}) {
  const base = topicLandscape(query, opts);
  if (base.error) return base;
  const years = Object.keys(base.patents.by_year).map(Number);
  const concepts = QueryMatch.parseQuery(String(query || "").trim().slice(0, 100));
  const oaQuery = openAlexQuery(concepts);
  const world = oaQuery ? await literature.fetchTopicYearCounts(oaQuery, years[0], years[years.length - 1]) : null;
  const out = { ...base, papers: { ...base.papers, note: "Knowledge-base papers are a crawled sample (for reading and citing), not a count of how much is published; see papers_world for that." } };
  if (!world) {
    out.papers_world = null;
    out.ratio_basis = "knowledge-base paper sample vs corpus patents (OpenAlex unavailable this time)";
    return out;
  }
  const byYear = Object.fromEntries(years.map((y) => [y, world.counts[y] || 0]));
  const recent = years.slice(-5);
  const prior = years.slice(-10, -5);
  const sum = (obj, ys) => ys.reduce((t, y) => t + (obj[y] || 0), 0);
  const a = sum(byYear, prior);
  out.papers_world = {
    population: "OpenAlex — all indexed scholarly works, title or abstract matching every concept of the query",
    openalex_query: oaQuery,
    matched: sum(byYear, years),
    by_year: byYear,
    growth_last5_vs_prev5_pct: a ? Math.round(((sum(byYear, recent) - a) / a) * 1000) / 10 : null,
  };
  const recentPatents = sum(base.patents.by_year, recent);
  out.research_to_patent_ratio_last5 = recentPatents ? Math.round((sum(byYear, recent) / recentPatents) * 100) / 100 : null;
  out.ratio_basis = "OpenAlex papers (worldwide) vs corpus patents (US/EP/JP/TW/SG/MY), last five years";
  return out;
}

// Search bar companion: knowledge-base patents matching the query with the same concept
// matcher as the corpus search (synonyms, Chinese <-> English), filtered by publication year and
// jurisdiction. Returns the total, a jurisdiction breakdown and one page of results.
function searchKbPatents(query, opts = {}) {
  return cached(JSON.stringify(["kb-patents", query, opts]), () => computeKbPatents(query, opts));
}

function computeKbPatents(query, { from, to, country, offset = 0, limit = 20 } = {}) {
  const q = String(query || "").trim().slice(0, 100);
  const concepts = QueryMatch.parseQuery(q);
  if (!concepts.length) return { error: "Empty or unusable query." };
  const kb = knowledgeStore.getStore().load();
  let population = 0;
  const hits = [];
  for (const { item } of kb.docs) {
    if (item.type !== "patent") continue;
    population++;
    if (from && item.year < from) continue;
    if (to && item.year > to) continue;
    const j = item.jurisdiction || String(item.publication_number || "").slice(0, 2);
    if (country && j !== country) continue;
    const s = QueryMatch.scorePatent(concepts, item, q);
    if (s > 0) hits.push({ item, s, j });
  }
  hits.sort((a, b) => b.s - a.s || String(b.item.date || b.item.year).localeCompare(String(a.item.date || a.item.year)));
  const byJur = {};
  for (const h of hits) byJur[h.j] = (byJur[h.j] || 0) + 1;
  return {
    query: q,
    population,
    total: hits.length,
    by_jurisdiction: Object.fromEntries(Object.entries(byJur).sort((a, b) => b[1] - a[1])),
    results: hits.slice(offset, offset + limit).map(({ item, j }) => ({
      publication_number: item.publication_number,
      title: item.title,
      abstract: item.abstract ? String(item.abstract).slice(0, 600) : "",
      date: item.date,
      jurisdiction: j,
      assignee: item.assignee || null,
      url: item.url,
      origin: item.origin,
    })),
  };
}

// White-space matrix, knowledge-base side: for the row × column IPC main groups the page derived
// from the corpus (e.g. "H04L 41"), count knowledge-base patents whose CPC codes fall in both.
// CPC and IPC share main groups, so "H04L41/0893" counts toward "H04L 41".
function cpcMainGroup(code) {
  const m = /^([A-H]\d{2}[A-Z])\s*(\d+)/.exec(String(code || "").trim());
  return m ? `${m[1]} ${m[2]}` : null;
}

function kbMatrixCounts(rows, cols) {
  return cached(JSON.stringify(["kb-matrix", rows, cols]), () => {
    const known = new Set([...rows, ...cols]);
    const kb = knowledgeStore.getStore().load();
    const counts = Object.fromEntries(rows.flatMap((a) => cols.map((b) => [`${a}|${b}`, 0])));
    let patents = 0, classified = 0;
    for (const { item } of kb.docs) {
      if (item.type !== "patent") continue;
      patents++;
      if (!Array.isArray(item.cpc) || !item.cpc.length) continue;
      classified++;
      const groups = new Set();
      for (const c of item.cpc) {
        const g = cpcMainGroup(c);
        if (g && known.has(g)) groups.add(g);
      }
      if (groups.size < 2) continue;
      for (const a of rows) if (groups.has(a)) for (const b of cols) if (groups.has(b)) counts[`${a}|${b}`]++;
    }
    return { kb_patents: patents, kb_classified: classified, counts };
  });
}

module.exports = { topicLandscape, topicLandscapeWithWorld, openAlexQuery, searchKbPatents, kbMatrixCounts, cpcMainGroup, hhiOf, concentrationLabel, _clearCache };
