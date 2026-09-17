// Deterministic, non-LLM feature extraction for "使用者上傳模式" (§③ Stage 0 / §④ features[]).
// This is intentionally a keyword heuristic, not an NLP model: the guardrail in
// ResearchGap_Agent_Skill_v2.md requires the backend's numbers to be reproducible and
// non-fabricated, so each matched keyword is mapped to whichever IPC main-group actually
// co-occurs most often with that keyword in the real corpus (computed at load time from
// patents.json titles/abstracts) — never a hand-picked IPC code.
const corpus = require("./corpus");

// Domain vocabulary for the SDN/NFV/network-slicing scope this skill is limited to
// (same scope named in §② description and §③ instructions). Extend this list rather than
// the scoring logic if new terms need to be recognized. Deliberately broad (2026-09-17:
// expanded from ~35 to ~110 terms after user feedback that a real uploaded paper only
// matched 2-3 generic words — "resource allocation"/"latency"/"5g" — which read as a
// shallow keyword scan rather than an actual analysis of the document's technology).
const VOCAB = [
  // SDN / NFV core
  "network slicing", "network slice", "sdn", "software defined network", "software-defined network",
  "nfv", "network function virtualization", "network functions virtualization", "virtual network function",
  "vnf", "vnfm", "nfvo", "mano", "openflow", "p4", "sdwan", "sd-wan",
  "control plane", "data plane", "forwarding plane", "management plane", "northbound api", "southbound api",
  "controller", "distributed controller", "flow table", "flow rule",
  // Orchestration / automation
  "orchestration", "orchestrator", "intent-based", "intent based", "intent driven", "zero-touch",
  "zero touch network", "closed-loop automation", "self-healing", "self-optimizing", "autonomic network",
  "service chain", "service function chaining", "sfc", "network slice selection", "slice orchestration",
  "provisioning", "self-service", "automated configuration", "policy engine", "declarative configuration",
  // Cloud-native / virtualization infrastructure
  "kubernetes", "container", "containerization", "microservice", "cloud native", "cloud-native",
  "virtual machine", "hypervisor", "service mesh", "edge computing", "mobile edge computing", "mec",
  "fog computing", "multi-access edge computing", "smartnic", "dpdk", "programmable switch",
  // 5G / 6G / RAN
  "5g", "6g", "beyond 5g", "ran", "o-ran", "open ran", "vran", "cran", "cloud ran",
  "gnb", "enb", "amf", "smf", "upf", "nwdaf", "ausf", "udm", "pcf", "nssf", "nrf",
  "beamforming", "massive mimo", "mmwave", "millimeter wave", "spectrum sharing", "carrier aggregation",
  "handover", "mobility management", "urllc", "embb", "mmtc", "network exposure function",
  // AI / ML / agentic
  "ai orchestration", "agentic ai", "machine learning", "deep learning", "reinforcement learning",
  "federated learning", "large language model", "llm", "digital twin", "predictive maintenance",
  "anomaly detection", "traffic prediction", "network digital twin",
  // QoS / reliability / security
  "qos", "quality of service", "latency", "throughput", "packet loss", "jitter", "sla",
  "reliability management", "fault tolerance", "load balancing", "traffic engineering",
  "network monitoring", "network telemetry", "resource allocation", "resource scheduling",
  "network security", "authentication", "zero trust", "encryption", "access control",
  "multi-tenant", "isolation", "network function placement", "vnf placement", "vnf migration",
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

// A 4-digit year regex, restricted to a plausible patent-era range, used to *suggest*
// candidate cutoff years to the caller.
const YEAR_RE = /\b(19[89]\d|20[0-2]\d|2030)\b/g;
function suggestPublicationYears(text) {
  const years = new Set();
  let m;
  YEAR_RE.lastIndex = 0;
  while ((m = YEAR_RE.exec(text || ""))) years.add(Number(m[0]));
  return [...years].sort((a, b) => b - a);
}

// Best single-year guess for auto-proceeding past the cutoff-year confirmation step
// without a round trip: the year mentioned most often in the text (a real paper's own
// publication/submission year typically recurs — title page, header, copyright line —
// more than any single cited reference's year), ties broken toward the more recent
// year. Still fully deterministic and reproducible from the real document text, not a
// model guess — the caller must still disclose the pick (and the runner-up candidates)
// to the user so a wrong guess is correctable, per 基準日鐵律.
function pickCutoffYear(text) {
  const counts = new Map();
  let m;
  YEAR_RE.lastIndex = 0;
  while ((m = YEAR_RE.exec(text || ""))) {
    const y = Number(m[0]);
    counts.set(y, (counts.get(y) || 0) + 1);
  }
  if (counts.size === 0) return null;
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0])[0][0];
}

module.exports = { extractFeatures, suggestPublicationYears, pickCutoffYear, VOCAB };
