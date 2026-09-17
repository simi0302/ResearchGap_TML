// Deterministic, non-LLM feature extraction for "upload mode" (POST /api/patentability,
// mode: upload). Two jobs live here:
//   1. extractFeatures(text) — which canonical technical features (from a fixed taxonomy,
//      not free-text keywords) are actually present in the document, ranked by TF-IDF
//      against the patent corpus, each mapped to an IPC main-group by lift (not raw
//      co-occurrence — see buildKeywordIpcMap below).
//   2. detectCutoffYear(text) — the document's own publication/filing year, using
//      first-page patterns before falling back to plain year-frequency, and excluding the
//      references section so citation years can't outvote the paper's own year.
// Both are pure functions of the real document text — never a model guess — so the same
// document always yields the same features/year (reproducibility, see README).
const corpus = require("./corpus");

// Canonical feature taxonomy for the SDN/NFV/network-slicing scope this tool is limited
// to. Each entry is matched two ways:
//   - phrases: multi-word or otherwise unambiguous terms, matched case-insensitively.
//   - acronyms: short tokens that collide with ordinary English words or common
//     substrings of unrelated words (RAN ⊂ "ran" the verb, MEC/SLA as substrings of
//     "mechanism"/"translation", etc. — the exact false positives that motivated this
//     rewrite). Matched case-sensitively (their real-world usage is always upper-case)
//     AND with a \b...\b word-boundary, which alone already rules out mid-word
//     substrings like "mec" inside "mechanism".
// Extend this list, don't hand-pick IPC codes — see buildKeywordIpcMap for how a feature
// gets mapped to a group.
const FEATURE_DEFS = [
  { id: "sdn", label: "Software-Defined Networking (SDN)",
    phrases: ["software-defined network", "software defined network", "software-defined networking", "software defined networking"],
    acronyms: ["SDN"] },
  { id: "nfv", label: "Network Function Virtualization (NFV)",
    phrases: ["network function virtualization", "network functions virtualization", "network function virtualisation"],
    acronyms: ["NFV", "VNF", "VNFM", "NFVO", "MANO"] },
  { id: "sfc", label: "Service Function Chaining (SFC)",
    phrases: ["service function chaining", "service chain", "network slice selection", "slice orchestration"],
    acronyms: ["SFC"] },
  { id: "network_slicing", label: "Network Slicing",
    phrases: ["network slicing", "network slice"], acronyms: [] },
  { id: "oran", label: "Open RAN (O-RAN)",
    phrases: ["o-ran", "open ran", "open radio access network", "cloud ran", "virtualized ran"],
    acronyms: ["RAN", "VRAN", "CRAN"] },
  { id: "orchestration", label: "Network Orchestration & Automation",
    phrases: [
      "orchestration", "orchestrator", "intent-based", "intent based", "intent driven",
      "zero-touch", "zero touch network", "closed-loop automation", "self-healing", "self-optimizing",
      "autonomic network", "declarative configuration", "policy engine", "automated configuration",
    ], acronyms: [] },
  { id: "openflow", label: "OpenFlow / Programmable Data Plane",
    phrases: [
      "openflow", "flow table", "flow rule", "programmable switch", "control plane", "data plane",
      "forwarding plane", "northbound api", "southbound api",
    ], acronyms: ["P4", "SDWAN", "SD-WAN"] },
  { id: "cloud_native", label: "Cloud-Native / Containerized Infrastructure",
    phrases: [
      "kubernetes", "container", "containerization", "microservice", "cloud native", "cloud-native",
      "service mesh", "virtual machine", "hypervisor",
    ], acronyms: ["DPDK"] },
  { id: "mec", label: "Multi-Access Edge Computing (MEC)",
    phrases: ["multi-access edge computing", "mobile edge computing", "edge computing", "fog computing"],
    acronyms: ["MEC"] },
  { id: "cellular_gen", label: "5G/6G Cellular",
    phrases: ["beyond 5g", "5g", "6g"], acronyms: [] },
  { id: "5g_core", label: "5G Core Network Functions",
    phrases: ["network exposure function"],
    acronyms: ["AMF", "SMF", "UPF", "NWDAF", "AUSF", "UDM", "PCF", "NSSF", "NRF", "GNB", "ENB"] },
  { id: "beamforming", label: "Beamforming / Massive MIMO",
    phrases: ["beamforming", "massive mimo", "mmwave", "millimeter wave", "spectrum sharing", "carrier aggregation"],
    acronyms: [] },
  { id: "mobility", label: "Handover & Mobility Management",
    phrases: ["handover", "mobility management"],
    acronyms: ["URLLC", "EMBB", "MMTC"] },
  { id: "ai_orchestration", label: "AI/ML-Driven Network Management",
    phrases: [
      "ai orchestration", "agentic ai", "machine learning", "deep learning", "reinforcement learning",
      "federated learning", "large language model", "digital twin", "predictive maintenance",
      "anomaly detection", "traffic prediction", "network digital twin",
    ], acronyms: ["LLM"] },
  { id: "qos", label: "QoS & Traffic Engineering",
    phrases: [
      "quality of service", "latency", "throughput", "packet loss", "jitter",
      "reliability management", "fault tolerance", "load balancing", "traffic engineering",
      "network monitoring", "network telemetry", "resource allocation", "resource scheduling",
    ], acronyms: ["QOS", "SLA"] },
  { id: "security", label: "Network Security & Access Control",
    phrases: ["network security", "authentication", "zero trust", "encryption", "access control", "multi-tenant", "isolation"],
    acronyms: [] },
  { id: "vnf_lifecycle", label: "VNF Placement & Lifecycle Management",
    phrases: ["network function placement", "vnf placement", "vnf migration", "provisioning", "self-service"],
    acronyms: [] },
];

const FEATURE_BY_ID = new Map(FEATURE_DEFS.map((f) => [f.id, f]));

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Word-boundary matcher. `\b` alone (with no internal escaping needed for spaces/hyphens)
// already rejects "mechanism" for "mec", "translation" for "sla", "transmission"/"range"
// for "ran" — the exact false positives extractFeatures() used to produce via
// String.includes(). Acronyms additionally skip the case-insensitive flag so a lowercase
// "ran" (the verb) can't match "RAN" (the acronym).
function findMatchIndexes(text, term, caseSensitive) {
  const re = new RegExp(`\\b${escapeRegex(term)}\\b`, caseSensitive ? "g" : "gi");
  const indexes = [];
  let m;
  while ((m = re.exec(text))) {
    indexes.push(m.index);
    if (m.index === re.lastIndex) re.lastIndex += 1; // guard against zero-width loops
  }
  return indexes;
}

// Which canonical features (by id) are present anywhere in a block of text, with every
// match's character offset — used both for document feature extraction and for scoring
// every corpus patent's own feature set (crowding/regional/novelty all key off the same
// matcher, so "matched" means the same thing everywhere in this backend).
function matchFeaturesInText(text) {
  const found = new Map(); // id -> [offsets]
  for (const def of FEATURE_DEFS) {
    const offsets = [];
    for (const p of def.phrases) offsets.push(...findMatchIndexes(text, p, false));
    for (const a of def.acronyms) offsets.push(...findMatchIndexes(text, a, true));
    if (offsets.length) found.set(def.id, offsets.sort((a, b) => a - b));
  }
  return found;
}

// --- Corpus-wide feature index (cached) --------------------------------------------
// Every corpus patent's own canonical feature set, computed once with the exact same
// matcher as extractFeatures() below — this is what makes "a patent counts as prior art
// evidence for feature F" and "the document contains feature F" the same test, not two
// heuristics that can silently disagree.
let _patentFeatureIndex = null;
function buildPatentFeatureIndex() {
  if (_patentFeatureIndex) return _patentFeatureIndex;
  const all = corpus.loadRawCorpus();
  _patentFeatureIndex = all.map((p) => {
    const text = `${p.title} ${p.abstract}`;
    return { patent: p, features: new Set(matchFeaturesInText(text).keys()) };
  });
  return _patentFeatureIndex;
}

function featureDocFreq(featureId) {
  return buildPatentFeatureIndex().filter((r) => r.features.has(featureId)).length;
}

// keyword(feature) → IPC main-group by LIFT, not raw co-occurrence: lift = P(group | this
// feature present) / P(group). Raw co-occurrence is base-rate biased toward whichever IPC
// group is simply the largest in the corpus (H04L 12 / OTHER) — lift corrects for that by
// dividing out each group's overall share. Requires >=3 co-occurring patents in a
// candidate group before trusting lift on it (small samples produce wild lift ratios);
// falls back to the raw-count leader if nothing clears that bar, and to null if the
// feature never co-occurs with a known group at all.
const MIN_GROUP_SUPPORT = 3;
let _keywordIpc = null;
function buildKeywordIpcMap() {
  if (_keywordIpc) return _keywordIpc;
  const index = buildPatentFeatureIndex();
  const baseRates = corpus.groupBaseRates();
  const map = new Map();
  for (const def of FEATURE_DEFS) {
    const counts = new Map();
    for (const { patent, features } of index) {
      if (!features.has(def.id)) continue;
      const g = corpus.subtechOf(patent);
      // "OTHER" is the catch-all for everything outside the corpus's top-N real IPC
      // groups — it isn't a coherent technology classification, so a feature must never
      // be "mapped" to it (that was root cause (f) of the original scoring bug: OTHER
      // got scored as if it were a real sub-technology). Exclude it here so a feature
      // either lands on a real group or gets null, never OTHER.
      if (g === "OTHER") continue;
      counts.set(g, (counts.get(g) || 0) + 1);
    }
    if (counts.size === 0) {
      map.set(def.id, null);
      continue;
    }
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    const withLift = [...counts.entries()]
      .filter(([, c]) => c >= MIN_GROUP_SUPPORT)
      .map(([g, c]) => ({ group: g, count: c, lift: (c / total) / (baseRates.get(g) || 1e-9) }))
      .sort((a, b) => b.lift - a.lift);
    if (withLift.length > 0) {
      map.set(def.id, { group: withLift[0].group, support: withLift[0].count, lift: withLift[0].lift });
    } else {
      const [group, count] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      map.set(def.id, { group, support: count, lift: null });
    }
  }
  _keywordIpc = map;
  return map;
}

// A short evidence snippet: the sentence (or ~140-char window if no clean sentence
// boundary is found) containing the first match, so a feature chip in the UI can show
// *why* it was picked, not just its name.
function snippetAround(text, index, matchLength) {
  const start = Math.max(0, text.lastIndexOf(".", index) + 1, text.lastIndexOf("\n", index) + 1, index - 140);
  let end = text.indexOf(".", index + matchLength);
  if (end === -1 || end - start > 280) end = Math.min(text.length, index + matchLength + 140);
  return text.slice(start, end + (text[end] === "." ? 1 : 0)).replace(/\s+/g, " ").trim();
}

const MAX_FEATURES = 8;

// Extract candidate technical features from free text (upload mode), ranked by TF-IDF
// against the patent corpus (rare/specific terms outrank generic ones that appear in
// nearly every patent) and capped at the top MAX_FEATURES. Returns
// [{id, feature_id, text, ipc, support, evidence}].
function extractFeatures(text) {
  const found = matchFeaturesInText(text || "");
  if (found.size === 0) return [];

  const keywordIpc = buildKeywordIpcMap();
  const N = corpus.loadRawCorpus().length;

  const scored = [...found.entries()].map(([id, offsets]) => {
    const def = FEATURE_BY_ID.get(id);
    const tf = offsets.length;
    const df = featureDocFreq(id);
    const idf = Math.log(N / (1 + df)) + 1; // +1 keeps idf positive even for very common features
    const info = keywordIpc.get(id);
    const firstOffset = offsets[0];
    // best-effort match length for the snippet window — use the shortest matched term's
    // length as a floor, good enough for a readable window either way.
    const approxLen = Math.min(...[...def.phrases, ...def.acronyms].map((t) => t.length));
    return {
      id,
      label: def.label,
      tf,
      idf,
      score: tf * idf,
      ipc: info ? info.group : null,
      support: info ? info.support : 0,
      evidence: snippetAround(text, firstOffset, approxLen),
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, MAX_FEATURES).map((f, i) => ({
    id: `F${i + 1}`,
    feature_id: f.id,
    text: f.label,
    ipc: f.ipc,
    support: f.support,
    evidence: f.evidence,
  }));
}

// --- Cutoff-year detection ----------------------------------------------------------
// A 4-digit year regex, restricted to a plausible patent-era range.
const YEAR_RE = /\b(19[89]\d|20[0-2]\d|2030)\b/g;

function suggestPublicationYears(text) {
  const years = new Set();
  let m;
  YEAR_RE.lastIndex = 0;
  while ((m = YEAR_RE.exec(text || ""))) years.add(Number(m[0]));
  return [...years].sort((a, b) => b - a);
}

// Drop everything from a References/Bibliography heading onward — citation lists are
// exactly the block of text most likely to bury the paper's own (recent) year under a
// pile of older cited years.
function stripReferencesSection(text) {
  const m = text.match(/\n\s*(references|bibliography|works cited)\s*\n/i);
  return m ? text.slice(0, m.index) : text;
}

// Blank out in-text citation years ("et al., 2022", "(Smith, 2022)", "[Smith et al.,
// 2022]", "[12], 2022") so they can't be counted as candidates for the paper's own year —
// these are almost always someone else's earlier publication year, not this document's.
function stripInTextCitationYears(text) {
  return text
    .replace(/\([^()]{0,120}?\b(19|20)\d{2}[a-z]?\b[^()]{0,40}?\)/g, " ")
    .replace(/\[[^[\]]{0,120}?\b(19|20)\d{2}[a-z]?\b[^[\]]{0,40}?\]/g, " ")
    .replace(/et\s+al\.?,?\s*(19|20)\d{2}[a-z]?/gi, " ");
}

// High-confidence first-page patterns, checked in priority order against the first ~4000
// characters of the (reference/citation-stripped) text. The first pattern that matches
// wins — these are all signals a paper states about *itself* (copyright line, submission/
// acceptance date, conference year, arXiv id), not a citation to someone else's work.
const FIRST_PAGE_PATTERNS = [
  { source: "copyright_line", re: /(?:©|\(c\)|copyright)\s*(19|20)\d{2}\b/i },
  { source: "published_accepted_received", re: /\b(published|accepted|received)\b(?:[^.\n]{0,30})?\b((19|20)\d{2})\b/i },
  { source: "conference_year", re: /\b((19|20)\d{2})\b[^.\n]{0,40}\b(conference|proceedings|symposium|workshop)\b|\b(conference|proceedings|symposium|workshop)\b[^.\n]{0,40}\b((19|20)\d{2})\b/i },
  { source: "arxiv_id", re: /\barxiv:\s*(\d{2})(\d{2})\.\d{4,5}/i },
];

function extractYearFromMatch(pattern, match) {
  if (pattern.source === "arxiv_id") {
    const yy = Number(match[1]);
    return 2000 + yy; // arXiv's YYMM ids only exist from 2007 onward, always 20YY
  }
  const years = match[0].match(/\b(19|20)\d{2}\b/g);
  return years ? Number(years[years.length - 1]) : null;
}

// Best single-year detection for auto-proceeding without a confirmation round trip.
// Priority: first-page self-referential patterns (copyright/published/conference/arXiv
// id) on reference- and citation-stripped text, then plain year frequency on the same
// cleaned text, then giving up (null — caller must ask the user). Returns
// {year, confidence, source} or null. Still fully deterministic/reproducible from the
// real document text, never a model guess.
function detectCutoffYear(text) {
  const raw = text || "";
  const cleaned = stripInTextCitationYears(stripReferencesSection(raw));
  const firstPage = cleaned.slice(0, 4000);

  for (const pattern of FIRST_PAGE_PATTERNS) {
    const m = firstPage.match(pattern.re);
    if (m) {
      const year = extractYearFromMatch(pattern, m);
      if (year) return { year, confidence: "high", source: pattern.source };
    }
  }

  const counts = new Map();
  let m;
  YEAR_RE.lastIndex = 0;
  while ((m = YEAR_RE.exec(cleaned))) {
    const y = Number(m[0]);
    counts.set(y, (counts.get(y) || 0) + 1);
  }
  if (counts.size === 0) return null;
  const [year] = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0];
  return { year, confidence: "low", source: "frequency_fallback" };
}

// Legacy name kept for callers that only want the bare year (patentability.js). Prefer
// detectCutoffYear() for anything that should also surface confidence/source.
function pickCutoffYear(text) {
  const r = detectCutoffYear(text);
  return r ? r.year : null;
}

module.exports = {
  FEATURE_DEFS,
  extractFeatures,
  matchFeaturesInText,
  buildPatentFeatureIndex,
  featureDocFreq,
  suggestPublicationYears,
  detectCutoffYear,
  pickCutoffYear,
};
