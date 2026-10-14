// White-space scan — "which technology combinations are still (nearly) empty, and what can be
// done with them?" — answered from patent data, deterministically.
//
// Technology groups = the 12 most frequent primary IPC main groups of the 2,799-patent corpus
// (the same groups the site's white-space matrix uses). For every pair of groups we count the
// patents classified under BOTH: corpus patents by their IPC codes, knowledge-base patents (GPSS,
// beyond the corpus) by their CPC codes — CPC and IPC share main groups.
//
// A pair is a white-space candidate when both sides are active but few patents combine them.
// "Few" is measured against what the two sides' sizes would predict if classification were
// independent (observed / expected, the lift used in co-occurrence analysis): a 0 next to two
// groups of 30 patents says little, a 3 next to two groups of 1,000 says a lot.
//
// For a single pair, cellDetail() adds what a researcher or a tech-transfer office needs to act
// on it: the applicants holding each side (who could license, partner or compete), applicants
// present on both sides, the patents that do combine the two (or, if none, the newest on each
// side), and the pair's trend. All counts; the wording of advice is left to the UI and the AI.
const corpus = require("./corpus");
const knowledgeStore = require("./knowledgeStore");
const { cpcMainGroup } = require("./landscape");

const GROUP_COUNT = 12;
// IPC 2022.01 moved most of H04L 29 to H04L 67/69, so newer patents rarely carry it: a sparse
// pair involving it is a classification artefact, not an untouched area.
const RECLASSIFIED = { "H04L 29": "Split up in the 2022 IPC revision (moved to H04L 67 / H04L 69); newer patents rarely carry it, so its counts run low." };

const CACHE_TTL_MS = 10 * 60 * 1000;
let cache = null;

function applicantOf(p) {
  const name = String(p.company_name || p.assignee || (p.assignees || [])[0] || "").trim();
  return name || null;
}
function yearOf(p) {
  return Number(String(p.publication_date || p.date || p.year || "").slice(0, 4)) || null;
}

function build() {
  const raw = corpus.loadRawCorpus();
  const counts = new Map();
  for (const p of raw) {
    const g = p.ipc.length ? corpus.ipcMainGroup(p.ipc[0]) : null;
    if (g) counts.set(g, (counts.get(g) || 0) + 1);
  }
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, GROUP_COUNT).map(([g]) => g);
  const known = new Set(groups);

  // One record per patent: which known groups it touches.
  const docs = [];
  for (const p of raw) {
    const gs = new Set();
    for (const code of p.ipc) {
      const g = corpus.ipcMainGroup(code);
      if (known.has(g)) gs.add(g);
    }
    docs.push({
      source: "corpus",
      groups: gs,
      publication_number: p.publication_number,
      title: p.title,
      year: yearOf(p),
      jurisdiction: p.jurisdiction,
      applicant: applicantOf(p),
      url: `https://patents.google.com/patent/${p.publication_number}/en`,
    });
  }
  let kbPatents = 0;
  let kbClassified = 0;
  for (const { item } of knowledgeStore.getStore().load().docs) {
    if (item.type !== "patent") continue;
    kbPatents++;
    if (!Array.isArray(item.cpc) || !item.cpc.length) continue;
    kbClassified++;
    const gs = new Set();
    for (const c of item.cpc) {
      const g = cpcMainGroup(c);
      if (g && known.has(g)) gs.add(g);
    }
    docs.push({
      source: "knowledge_base",
      groups: gs,
      publication_number: item.publication_number,
      title: item.title,
      year: item.year,
      jurisdiction: item.jurisdiction,
      applicant: applicantOf(item),
      url: item.url,
    });
  }

  const groupTotals = Object.fromEntries(groups.map((g) => [g, docs.filter((d) => d.groups.has(g)).length]));
  const population = docs.length;
  const pairs = [];
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      const a = groups[i];
      const b = groups[j];
      let n = 0;
      let nCorpus = 0;
      for (const d of docs) {
        if (d.groups.has(a) && d.groups.has(b)) {
          n++;
          if (d.source === "corpus") nCorpus++;
        }
      }
      const expected = (groupTotals[a] * groupTotals[b]) / population;
      pairs.push({
        a,
        b,
        label_a: corpus.representativeLabel(a),
        label_b: corpus.representativeLabel(b),
        patents: n,
        corpus: nCorpus,
        knowledge_base: n - nCorpus,
        side_a_patents: groupTotals[a],
        side_b_patents: groupTotals[b],
        expected: Math.round(expected * 10) / 10,
        lift: expected ? Math.round((n / expected) * 100) / 100 : null,
        caveat: RECLASSIFIED[a] || RECLASSIFIED[b] || null,
      });
    }
  }
  return { groups, groupTotals, docs, pairs, population, kbPatents, kbClassified, at: Date.now() };
}

function data() {
  if (!cache || Date.now() - cache.at > CACHE_TTL_MS) cache = build();
  return cache;
}
function _clearCache() {
  cache = null;
}

function populationText(d) {
  return `${d.population - d.kbClassified} corpus patents (GPSS, extracted 2026-06-03) + ${d.kbClassified} classified knowledge-base patents (GPSS, beyond the corpus; ${d.kbPatents - d.kbClassified} without CPC codes left out)`;
}

// Candidates: both sides must be sizeable (otherwise a low count means nothing), artefact pairs
// last, then by lift ascending (most under-combined first).
function scanWhiteSpace({ limit = 8, minSide = 150 } = {}) {
  const d = data();
  const candidates = d.pairs
    .filter((p) => p.side_a_patents >= minSide && p.side_b_patents >= minSide)
    .sort((x, y) => (x.caveat ? 1 : 0) - (y.caveat ? 1 : 0) || x.lift - y.lift || x.patents - y.patents)
    .slice(0, limit);
  const crowded = d.pairs.slice().sort((x, y) => y.patents - x.patents).slice(0, 3);
  // The two strongest candidates come with their detail, so "how could this be used" can be
  // answered from the same call.
  const details = candidates.filter((c) => !c.caveat).slice(0, 2).map((c) => {
    const x = cellDetail(c.a, c.b);
    return { a: c.a, b: c.b, combined_patents: x.combined_patents.slice(0, 3), newest_side_a: x.newest_side_a, newest_side_b: x.newest_side_b, top_applicants_side_a: x.top_applicants_side_a.slice(0, 3), top_applicants_side_b: x.top_applicants_side_b.slice(0, 3), applicants_on_both_sides: x.applicants_on_both_sides, trend: x.trend };
  });
  const table_markdown = [
    "| Combination | Patents combining both | Expected from side sizes | Lift | Side A / side B patents |",
    "|---|---|---|---|---|",
    ...candidates.filter((c) => !c.caveat).slice(0, 5).map((c) => `| ${c.label_a} (${c.a}) × ${c.label_b} (${c.b}) | ${c.patents} | ${c.expected} | ${c.lift} | ${c.side_a_patents} / ${c.side_b_patents} |`),
  ].join("\n");
  return {
    population: populationText(d),
    table_markdown,
    groups: d.groups.map((g) => ({ ipc: g, label: corpus.representativeLabel(g), patents: d.groupTotals[g], caveat: RECLASSIFIED[g] || undefined })),
    method:
      "Pairs of the 12 largest IPC main groups. patents = patents classified under both groups; expected = (side A × side B) / population, i.e. the count if the two classifications were unrelated; lift = patents / expected. Lift well below 1 with two large sides = a combination the field has under-explored: a white-space candidate to examine, not proof of patentability.",
    no_cutoff: "Field-wide scan over every patent in the population; no cutoff year applies.",
    answer_format:
      "Not the Stage 3 table. (1) One sentence naming the strongest candidate with patents vs expected. (2) table_markdown, pasted exactly. (3) 'How this can be used' for the top two (top_candidate_details): research or patent entry point — the patents that already combine the two (or the newest on each side), number + link, are what a new claim must be distinguished from; technology transfer — applicants on both sides and each side's top applicants are the likeliest licensees, partners or competitors. (4) What this suggests / does not prove, naming the population. (5) References and Evidence map.",
    candidates,
    top_candidate_details: details,
    most_crowded: crowded,
  };
}

// Corpus and GPSS spell the same applicant differently ("Huawei Technologies Co." / "Huawei
// Technologies Co., Ltd.", "Intel Corp." / "Intel Corporation"): group on the name without its
// legal-form suffix, and show the shortest spelling seen.
const LEGAL_FORM = /\b(co|company|corp|corporation|inc|incorporated|ltd|limited|llc|lp|plc|gmbh|ag|sa|ab|publ|oy|kk|bv|nv)\b/g;
function applicantKey(name) {
  return String(name)
    .toLowerCase()
    .replace(/\(.*?\)/g, " ")
    .replace(/\b(l\.l\.c|l\.p|s\.a)\./g, " ")
    .replace(/[.,]/g, " ")
    .replace(LEGAL_FORM, " ")
    .replace(/[^a-z0-9&\u3040-\u9fff]+/g, " ")
    .trim();
}
function topApplicants(docs, n = 5) {
  const groups = new Map();
  for (const d of docs) {
    if (!d.applicant) continue;
    const key = applicantKey(d.applicant) || d.applicant;
    const g = groups.get(key) || { name: d.applicant, patents: 0 };
    g.patents++;
    if (d.applicant.length < g.name.length) g.name = d.applicant;
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.patents - a.patents).slice(0, n).map(({ name, patents }) => ({ name, patents }));
}
function brief(d) {
  return { publication_number: d.publication_number, title: d.title, year: d.year, jurisdiction: d.jurisdiction, applicant: d.applicant, url: d.url, source: d.source };
}
const newestFirst = (x, y) => (y.year || 0) - (x.year || 0);

function cellDetail(a, b) {
  const d = data();
  if (!d.groups.includes(a) || !d.groups.includes(b) || a === b) return { error: "Unknown group pair." };
  const pair = d.pairs.find((p) => (p.a === a && p.b === b) || (p.a === b && p.b === a));
  const sideA = d.docs.filter((x) => x.groups.has(a));
  const sideB = d.docs.filter((x) => x.groups.has(b));
  const both = sideA.filter((x) => x.groups.has(b));
  const appA = topApplicants(sideA, 8);
  const appB = topApplicants(sideB, 8);
  const namesB = new Map(appB.map((x) => [applicantKey(x.name), x.patents]));
  const onBothSides = topApplicants(sideA, 40)
    .filter((x) => namesB.has(applicantKey(x.name)))
    .map((x) => ({ name: x.name, side_a: x.patents, side_b: namesB.get(applicantKey(x.name)) }))
    .slice(0, 5);
  const lastYear = new Date().getFullYear() - 1;
  const recent = both.filter((x) => x.year > lastYear - 5 && x.year <= lastYear).length;
  const prior = both.filter((x) => x.year > lastYear - 10 && x.year <= lastYear - 5).length;
  return {
    population: populationText(d),
    pair: { ...pair, label_a: corpus.representativeLabel(a), label_b: corpus.representativeLabel(b) },
    combined_patents: both.slice().sort(newestFirst).slice(0, 6).map(brief),
    newest_side_a: both.length ? [] : sideA.slice().sort(newestFirst).slice(0, 3).map(brief),
    newest_side_b: both.length ? [] : sideB.slice().sort(newestFirst).slice(0, 3).map(brief),
    top_applicants_side_a: appA.slice(0, 5),
    top_applicants_side_b: appB.slice(0, 5),
    applicants_on_both_sides: onBothSides,
    trend: { window: `${lastYear - 9}–${lastYear}`, last5: recent, previous5: prior },
  };
}

module.exports = { scanWhiteSpace, cellDetail, applicantKey, _clearCache, RECLASSIFIED };
