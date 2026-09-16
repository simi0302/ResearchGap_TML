// Loads the same real patent corpus the frontend uses (frontend/public/data/patents.json,
// 2,799 SDN/NFV patents — see frontend/README.md's data pipeline) and derives the
// backend-computable inputs for the patentability score (§⑤ of ResearchGap_Agent_Skill_v2.md):
// cutoff filtering, a data-driven "sub-technology" taxonomy from real IPC codes, prior-art
// density percentiles, and applicant concentration (HHI). No numbers here are invented —
// everything traces back to fields already present in patents.json.
const fs = require("fs");
const path = require("path");

// A copy of frontend/public/data/patents.json lives at backend/data/patents.json so the
// backend deploys as a self-contained unit (az webapp up only zips this directory — a sibling
// ../frontend/ is not included, which silently made every /api/patentability call 500 on Azure
// until this was caught 2026-09-16). Keep both copies in sync if the corpus is ever regenerated.
const CORPUS_PATH = path.join(__dirname, "data", "patents.json");
const SUBTECH_COUNT = 12; // matches the "12 子技術" language in the spec; see deriveSubtechGroups()

let _cache = null;

function loadRawCorpus() {
  if (_cache) return _cache;
  const raw = JSON.parse(fs.readFileSync(CORPUS_PATH, "utf-8"));
  _cache = raw.map((r) => ({
    publication_number: r.publication_number,
    title: r.title || "",
    abstract: r.abstract || "",
    jurisdiction: r.jurisdiction,
    company_name: r.company_name || "",
    assignees: Array.isArray(r.assignees) && r.assignees.length ? r.assignees : (r.company_name ? [r.company_name] : []),
    ipc: Array.isArray(r.ipc) ? r.ipc : [],
    publication_date: r.publication_date || null,
    filing_date: r.filing_date || null,
    category: r.category || null,
  }));
  return _cache;
}

// "H04L 41/0895(2022.01)" -> "H04L 41" (class + main group, drops subgroup/year).
function ipcMainGroup(code) {
  const stripped = String(code).split("(")[0].trim();
  const parts = stripped.split("/");
  return parts[0].trim();
}

function primaryGroup(patent) {
  if (!patent.ipc.length) return null;
  return ipcMainGroup(patent.ipc[0]);
}

// Data-driven "sub-technology" taxonomy: the SUBTECH_COUNT most frequent IPC main-groups
// (by primary IPC code) across the whole corpus, everything else folds into "OTHER".
// This is what the spec's five-factor formula calls "12 子技術" — it's derived from the
// real IPC distribution at load time, not a fixed/invented list.
let _subtechGroups = null;
function deriveSubtechGroups() {
  if (_subtechGroups) return _subtechGroups;
  const corpus = loadRawCorpus();
  const counts = new Map();
  for (const p of corpus) {
    const g = primaryGroup(p);
    if (!g) continue;
    counts.set(g, (counts.get(g) || 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, SUBTECH_COUNT).map(([g]) => g);
  _subtechGroups = new Set(top);
  return _subtechGroups;
}

function subtechOf(patent) {
  const groups = deriveSubtechGroups();
  const g = primaryGroup(patent);
  return g && groups.has(g) ? g : "OTHER";
}

function allSubtechLabels() {
  return [...deriveSubtechGroups(), "OTHER"];
}

// Cutoff rule (基準日鐵律): only patents publicly disclosed on/before cutoffDate count as
// prior art / corpus context for a score as-of that date. cutoffDate is an ISO "YYYY-MM-DD" string.
function filterByCutoff(patents, cutoffDate) {
  if (!cutoffDate) return patents;
  return patents.filter((p) => p.publication_date && p.publication_date <= cutoffDate);
}

// Factor: prior_art_density = 1 − percentile(subtech density among all subtechs).
// "百分位" = fraction of subtechs that are less crowded than this one, within the
// cutoff-filtered corpus. Returns { value, note }.
function priorArtDensityFactor(cutoffPatents, subtechLabel) {
  const labels = allSubtechLabels();
  const counts = new Map(labels.map((l) => [l, 0]));
  for (const p of cutoffPatents) {
    const l = subtechOf(p);
    counts.set(l, (counts.get(l) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => a[1] - b[1]);
  const idx = sorted.findIndex(([l]) => l === subtechLabel);
  const thisCount = counts.get(subtechLabel) || 0;
  const percentile = sorted.length > 1 ? idx / (sorted.length - 1) : 0;
  const value = Math.max(0, Math.min(1, 1 - percentile));
  return {
    value,
    note: `同組合（IPC ${subtechLabel}）在基準日前的母體中有 ${thisCount} 件，位於 ${labels.length} 個子技術分組中第 ${idx + 1} 擁擠（越擁擠分數越低）。`,
  };
}

// Raw same-subtech patent count within the cutoff-filtered corpus — used by the POS
// Crowding factor (references/pos-scoring.md: "同 CPC×場景檢索命中數 ÷ 200").
function subtechCount(cutoffPatents, subtechLabel) {
  let n = 0;
  for (const p of cutoffPatents) if (subtechOf(p) === subtechLabel) n++;
  return n;
}

// Same-subtech, same-jurisdiction patent count — used to approximate the POS Regional
// factor's family-gap term. Note: this is jurisdiction presence, not true patent-family
// linkage (patents.json has no family id), so it is an honest approximation, not exact —
// see the note text returned alongside it in regionalFactor().
function subtechJurisdictionCount(cutoffPatents, subtechLabel, jurisdiction) {
  let n = 0;
  for (const p of cutoffPatents) if (subtechOf(p) === subtechLabel && p.jurisdiction === jurisdiction) n++;
  return n;
}

// Factor: applicant_concentration = 1 − HHI/10000, computed within the subtech + cutoff-filtered set.
function applicantConcentrationFactor(cutoffPatents, subtechLabel) {
  const inGroup = cutoffPatents.filter((p) => subtechOf(p) === subtechLabel);
  const counts = new Map();
  for (const p of inGroup) {
    const applicant = p.assignees[0] || p.company_name || "unknown";
    counts.set(applicant, (counts.get(applicant) || 0) + 1);
  }
  const total = inGroup.length;
  let hhi = 0;
  let topApplicant = null;
  let topShare = 0;
  for (const [name, c] of counts) {
    const share = total ? c / total : 0;
    hhi += share * share * 10000;
    if (share > topShare) {
      topShare = share;
      topApplicant = name;
    }
  }
  const value = total ? Math.max(0, Math.min(1, 1 - hhi / 10000)) : 0.5;
  const note = total
    ? `該子技術在基準日前共 ${total} 件，HHI ${Math.round(hhi)}${topApplicant ? `，最大申請人 ${topApplicant}（占比 ${(topShare * 100).toFixed(0)}%）` : ""}。`
    : "該子技術在基準日前無母體資料，因子暫定中性值 0.5。";
  return { value, note };
}

// Zero-filing "white space" signal within the cutoff-filtered corpus, generalized from the
// existing WhiteSpacePage logic to the finer 12-subtech × jurisdiction grid.
function whitespaceSignal(cutoffPatents) {
  const labels = allSubtechLabels();
  const jurs = ["US", "EP", "JP", "TW", "SG", "MY"];
  const counts = new Map();
  for (const l of labels) for (const j of jurs) counts.set(`${l}|${j}`, 0);
  for (const p of cutoffPatents) {
    const l = subtechOf(p);
    if (jurs.includes(p.jurisdiction)) {
      const k = `${l}|${p.jurisdiction}`;
      counts.set(k, (counts.get(k) || 0) + 1);
    }
  }
  const gaps = [];
  for (const l of labels) {
    for (const j of jurs) {
      if ((counts.get(`${l}|${j}`) || 0) === 0) gaps.push({ subtech: l, jurisdiction: j });
    }
  }
  return gaps;
}

// Human-readable label for an IPC subtech group, derived from the most frequent
// non-generic title words among patents actually classified under that group — not a
// hand-picked name. "OTHER" (the catch-all bucket) isn't a coherent classification, so it
// gets a fixed literal label instead of a computed one.
const LABEL_STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "for", "in", "to", "with", "based", "method", "methods",
  "system", "systems", "device", "devices", "apparatus", "apparatuses", "using", "via", "from",
  "on", "by", "its", "into", "at", "is", "are", "be", "same", "such", "thereof", "network", "networks",
  "networking", "non", "first", "second", "one", "more",
]);
// Distinctiveness, not raw frequency: this corpus is entirely SDN/NFV/slicing patents, so
// generic words ("slice", "controller", "function"...) dominate every group's raw word
// counts and would give different IPC groups the same label. Instead score each word by
// what fraction of its TOTAL occurrences across the whole corpus fall inside this one
// group — a word concentrated in one group scores near 1, a word spread evenly across all
// groups scores near 1/N — computed once for every group together so labels can't collide
// by construction the way independent per-group top-1 picks could.
let _labelCache = null;
function buildLabels() {
  if (_labelCache) return _labelCache;
  const all = loadRawCorpus();
  const groups = allSubtechLabels();
  const globalCounts = new Map();
  const groupCounts = new Map(groups.map((g) => [g, new Map()]));
  for (const p of all) {
    const g = subtechOf(p);
    const words = (p.title || "").toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || [];
    const seenInTitle = new Set(); // one repetitive title can't dominate the count
    for (const w of words) {
      if (LABEL_STOPWORDS.has(w) || seenInTitle.has(w)) continue;
      seenInTitle.add(w);
      globalCounts.set(w, (globalCounts.get(w) || 0) + 1);
      const gc = groupCounts.get(g);
      gc.set(w, (gc.get(w) || 0) + 1);
    }
  }
  const labels = new Map();
  for (const g of groups) {
    if (g === "OTHER") {
      labels.set(g, "Other / 未分類");
      continue;
    }
    const gc = groupCounts.get(g);
    // Two-stage pick: first keep only words that are reasonably exclusive to this group
    // (>=30% of the word's total corpus occurrences happen here) so different groups can't
    // converge on the same generic term, then rank what's left by how common it is WITHIN
    // the group, so the label favors "the thing this group is mostly about," not just
    // whatever rare word happens to be the most exclusive.
    const qualifying = [...gc.entries()]
      .filter(([w, c]) => c >= 4 && c / (globalCounts.get(w) || 1) >= 0.3)
      .sort((a, b) => b[1] - a[1]);
    const top = qualifying.slice(0, 2).map(([w]) => w);
    labels.set(g, top.length ? top.map((w) => w[0].toUpperCase() + w.slice(1)).join(" ") : null);
  }
  _labelCache = labels;
  return labels;
}
function representativeLabel(group) {
  return buildLabels().get(group) || `IPC ${group}`;
}

// Which subtech groups a patent actually touches — every one of its IPC codes' main groups
// that's among the corpus's top subtech groups, not just the primary (first) one. This is
// what makes a "combination" mean something real: a patent counts toward A×B only if it is
// itself classified under both A and B.
function groupsOf(patent, knownGroups) {
  const set = new Set();
  for (const code of patent.ipc) {
    const g = ipcMainGroup(code);
    if (knownGroups.has(g)) set.add(g);
  }
  return set;
}

// Real technology-combination cross-tab for a given case's subtech against every other
// known subtech, computed only from the cutoff-filtered corpus (§ 基準日鐵律). This is what
// backs the White-Space table when it's showing a real analyzed case, not the static example.
function combinationWhitespace(cutoffPatents, subtechLabel, limit = 12) {
  // "OTHER" means the case itself couldn't be classified into any real IPC group (no
  // features had an IPC code) — there is no real group to cross-tabulate against anything,
  // so returning rows here would show a false "gap" for every row rather than the true
  // "we don't know" state.
  if (subtechLabel === "OTHER") return [];
  // subtechLabel is the CASE's own primary IPC group, which may or may not be one of the
  // corpus's top-12 "known" groups (a case can be classified under a less-common group even
  // though every *comparison* axis is drawn from the top 12) — it must still count as a real
  // group in groupsOf() below, or no patent (including genuine matches) could ever match it.
  const knownGroups = new Set(deriveSubtechGroups());
  knownGroups.add(subtechLabel);
  const others = allSubtechLabels().filter((l) => l !== subtechLabel && l !== "OTHER");
  const patentGroupSets = cutoffPatents.map((p) => groupsOf(p, knownGroups));

  const labelA = representativeLabel(subtechLabel);
  const rows = others.map((other) => {
    let count = 0;
    for (const groups of patentGroupSets) {
      if (groups.has(subtechLabel) && groups.has(other)) count++;
    }
    const status = count === 0 ? "gap" : count < 5 ? "developing" : "crowded";
    const labelB = representativeLabel(other);
    return {
      combo_a: labelA,
      combo_b: labelB,
      ipc_a: subtechLabel,
      ipc_b: other,
      count,
      status,
      evidence_en: `Among patents published before the cutoff date, ${count} are classified under both "${labelA}" (${subtechLabel}) and "${labelB}" (${other}).`,
      evidence_zh: `語料庫中基準日前同時歸類於「${labelA}」(${subtechLabel}) 與「${labelB}」(${other}) 的專利共 ${count} 件。`,
    };
  });

  rows.sort((a, b) => a.count - b.count); // gaps (count 0) first — the actionable rows
  return rows.slice(0, limit);
}

function corpusMeta(cutoffDate) {
  const all = loadRawCorpus();
  const before = filterByCutoff(all, cutoffDate);
  return { n: all.length, n_before_cutoff: before.length, source: "GPSS (frontend/public/data/patents.json)", extracted: "2026-06-03" };
}

function findByPublicationNumber(publication_number) {
  return loadRawCorpus().find((p) => p.publication_number === publication_number) || null;
}

module.exports = {
  loadRawCorpus,
  ipcMainGroup,
  subtechOf,
  allSubtechLabels,
  filterByCutoff,
  priorArtDensityFactor,
  subtechCount,
  subtechJurisdictionCount,
  applicantConcentrationFactor,
  whitespaceSignal,
  representativeLabel,
  combinationWhitespace,
  corpusMeta,
  findByPublicationNumber,
};
