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
  corpusMeta,
  findByPublicationNumber,
};
