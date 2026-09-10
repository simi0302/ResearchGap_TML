// Deterministic, non-LLM feature extraction for "使用者上傳模式" (§③ Stage 0 / §④ features[]).
// This is intentionally a keyword heuristic, not an NLP model: the guardrail in
// ResearchGap_Agent_Skill_v2.md requires the backend's numbers to be reproducible and
// non-fabricated, so each matched keyword is mapped to whichever IPC main-group actually
// co-occurs most often with that keyword in the real corpus (computed at load time from
// patents.json titles/abstracts) — never a hand-picked IPC code.
const corpus = require("./corpus");

// Domain vocabulary for the SDN/NFV/network-slicing scope this skill is limited to
// (same scope named in §② description and §③ instructions). Extend this list rather than
// the scoring logic if new terms need to be recognized.
const VOCAB = [
  "network slicing", "network slice", "sdn", "software defined network", "software-defined network",
  "nfv", "network function virtualization", "network functions virtualization",
  "intent-based", "intent based", "orchestration", "orchestrator",
  "controller", "control plane", "data plane", "edge computing",
  "digital twin", "6g", "5g", "ai orchestration", "agentic ai",
  "service chain", "service function chaining", "vnf", "network slice selection",
  "amf", "smf", "upf", "nwdaf", "qos", "latency", "reliability management",
  "provisioning", "self-service", "automated configuration", "anomaly detection",
  "network monitoring", "resource allocation", "network security", "authentication",
];

let _keywordIpc = null;

// For each vocabulary term, find the IPC main-group that most often co-occurs with it in
// patent titles/abstracts across the whole corpus. Returns Map(term -> {group, support}).
function buildKeywordIpcMap() {
  if (_keywordIpc) return _keywordIpc;
  const all = corpus.loadRawCorpus();
  const map = new Map();
  for (const term of VOCAB) {
    const counts = new Map();
    for (const p of all) {
      const text = `${p.title} ${p.abstract}`.toLowerCase();
      if (!text.includes(term)) continue;
      const g = corpus.subtechOf(p);
      counts.set(g, (counts.get(g) || 0) + 1);
    }
    if (counts.size === 0) {
      map.set(term, null);
      continue;
    }
    const [group, support] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    map.set(term, { group, support });
  }
  _keywordIpc = map;
  return map;
}

// Extract candidate technical features from free text (upload mode). Returns
// [{id, text, ipc, support}]. `support` = how many corpus patents co-occur with this term,
// so the caller/Agent can see this is a heuristic, not a guaranteed classification.
function extractFeatures(text) {
  const lower = (text || "").toLowerCase();
  const keywordIpc = buildKeywordIpcMap();
  const matched = [];
  for (const term of VOCAB) {
    if (!lower.includes(term)) continue;
    const info = keywordIpc.get(term);
    matched.push({
      text: term,
      ipc: info ? info.group : null,
      support: info ? info.support : 0,
    });
  }
  // Longer/more specific terms first (e.g. "network function virtualization" before "nfv"
  // duplicates aren't merged here — caller can dedupe by ipc group if desired).
  matched.sort((a, b) => b.text.length - a.text.length);
  return matched.map((m, i) => ({ id: `F${i + 1}`, ...m }));
}

// A 4-digit year regex, restricted to a plausible patent-era range, used only to *suggest*
// a cutoff year to the caller — per Stage 0 the caller must still get user confirmation,
// this never auto-decides the cutoff.
function suggestPublicationYears(text) {
  const years = new Set();
  const re = /\b(19[89]\d|20[0-2]\d|2030)\b/g;
  let m;
  while ((m = re.exec(text || ""))) years.add(Number(m[0]));
  return [...years].sort((a, b) => b - a);
}

module.exports = { extractFeatures, suggestPublicationYears, VOCAB };
