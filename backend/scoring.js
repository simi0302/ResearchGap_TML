// POS (Patent Opportunity Score) — the four-factor formula from
// docs/agent-specs/researchgap-patent-whitespace/references/pos-scoring.md (skill v3.0,
// 2026-09-10). Score = 100 × Σ(weight_i × sub_i), each sub-score normalized to 0–1.
// Novelty needs prior art the Agent found on the web; until prior_art is supplied it stays at
// a neutral 0.5 with a note — never guessed, per the anti-fabrication guardrail. Crowding and
// the concentration half of Regional are always computable from the real corpus. Temporal
// needs Agent-supplied literature[]; without it, it falls back to 0.5 with an explicit note,
// exactly as the spec requires ("只有質性描述固定 0.5"). Regional's family-gap half is an
// honest approximation (jurisdiction presence, not true patent-family linkage — see corpus.js).
const corpus = require("./corpus");

const WEIGHTS = {
  novelty: 0.40,
  crowding: 0.25,
  temporal: 0.20,
  regional: 0.15,
};

const DEFAULT_TARGET_JURISDICTION = "TW";

function jaccard(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 1;
  const inter = [...setA].filter((x) => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : inter / union;
}

// Novelty = 0.5×(1 − max Jaccard vs top-5 prior art) + 0.5×(unmatched features ÷ total features).
// prior_art: [{patent_no, year, matched_features: ["F1","F3", ...]}], up to top-5 by similarity,
// as returned by the Agent's search_prior_art tool.
function noveltyFactor(features, priorArt) {
  if (!priorArt || priorArt.length === 0) {
    return { value: 0.5, note: "尚無前案比對資料（待 Agent 全網路廣蒐後回傳 prior_art[]），因子暫定中性值 0.5。" };
  }
  const caseIds = new Set(features.map((f) => f.id));
  const top5 = priorArt.slice(0, 5);

  let maxJ = 0;
  let closest = null;
  const matchedAnywhere = new Set();
  for (const pa of top5) {
    const paIds = new Set(pa.matched_features || []);
    for (const fid of paIds) matchedAnywhere.add(fid);
    const j = jaccard(caseIds, paIds);
    if (j >= maxJ) {
      maxJ = j;
      closest = pa;
    }
  }
  const total = features.length || 1;
  const unmatched = features.filter((f) => !matchedAnywhere.has(f.id)).length;

  const uniquenessOverlap = Math.max(0, Math.min(1, 1 - maxJ));
  const uniquenessRatio = Math.max(0, Math.min(1, unmatched / total));
  const value = 0.5 * uniquenessOverlap + 0.5 * uniquenessRatio;

  const note = closest
    ? `與最接近前案 ${closest.patent_no || "(未標號)"} 的特徵重疊度 ${(maxJ * 100).toFixed(0)}%；${features.length} 項特徵中有 ${unmatched} 項未見於任一提供的前案。`
    : `前案清單為空，視為無重疊；${features.length} 項特徵中有 ${unmatched} 項未見於任一提供的前案。`;
  return { value, note };
}

// Crowding = 1 − min(1, 同子技術基準日前命中數 ÷ 200).
function crowdingFactor(cutoffPatents, subtechLabel) {
  const hits = corpus.subtechCount(cutoffPatents, subtechLabel);
  const value = Math.max(0, Math.min(1, 1 - hits / 200));
  return {
    value,
    note: `同組合（IPC ${subtechLabel}）在基準日前的母體中有 ${hits} 件命中（以 200 件為擁擠上限正規化，越多分越低）。`,
  };
}

// Temporal = 基準日前 3 年論文年增率正規化；若同期同子技術專利數 > 論文數則 ×0.5；
// 只有質性描述（無逐年數字）固定 0.5。
function temporalFactor(literature, cutoffYear, cutoffPatents, subtechLabel) {
  if (!literature || literature.length === 0) {
    return { value: 0.5, note: "文獻端無逐年數字（本 repo 尚無真實論文檢索資料），因子暫定中性值 0.5，如需精確值請提供 literature[]。" };
  }
  const byYear = new Map();
  for (const l of literature) {
    if (typeof l.year !== "number" || l.year > cutoffYear) continue;
    byYear.set(l.year, (byYear.get(l.year) || 0) + 1);
  }
  const years = [...byYear.keys()].sort((a, b) => a - b);
  if (years.length < 2) {
    return { value: 0.5, note: "提供的文獻年份不足以計算近 3 年年增率，因子暫定中性值 0.5。" };
  }
  const recentYears = years.slice(-3);
  const first = byYear.get(recentYears[0]);
  const last = byYear.get(recentYears[recentYears.length - 1]);
  const growth = first > 0 ? (last - first) / first : last > 0 ? 1 : 0;
  let value = Math.max(0, Math.min(1, 0.5 + growth / 2));

  const literatureCountRecent = recentYears.reduce((sum, y) => sum + byYear.get(y), 0);
  const patentCountRecent = cutoffPatents.filter((p) => {
    if (corpus.subtechOf(p) !== subtechLabel) return false;
    const y = Number(String(p.publication_date || "").slice(0, 4));
    return y && recentYears.includes(y);
  }).length;

  let halved = false;
  if (patentCountRecent > literatureCountRecent) {
    value = value * 0.5;
    halved = true;
  }

  const note = `近 ${recentYears.length} 年（${recentYears[0]}–${recentYears[recentYears.length - 1]}）文獻數由 ${first} 增至 ${last}${
    halved ? `；同期同組合專利數 ${patentCountRecent} 件已多於文獻數 ${literatureCountRecent} 件，分數折半。` : "。"
  }`;
  return { value, note };
}

// Regional = 0.5×(目標法域在基準日前無同組合命中 ? 1 : 0) + 0.5×(1 − 該組合申請人 HHI ÷ 10000).
// The family-gap half is an approximation (jurisdiction presence, not true patent-family
// linkage — patents.json has no family id) and is disclosed as such in the note.
function regionalFactor(cutoffPatents, subtechLabel, targetJurisdiction) {
  const target = targetJurisdiction || DEFAULT_TARGET_JURISDICTION;
  const targetHits = corpus.subtechJurisdictionCount(cutoffPatents, subtechLabel, target);
  const gapTerm = targetHits === 0 ? 1 : 0;

  const concentration = corpus.applicantConcentrationFactor(cutoffPatents, subtechLabel);
  const value = 0.5 * gapTerm + 0.5 * concentration.value;

  const note = `目標法域 ${target} 在基準日前的同組合命中數為 ${targetHits} 件${gapTerm ? "（無對應申請案，region gap）" : ""}（以命中數近似家族缺口，非逐案專利家族比對）；${concentration.note}`;
  return { value, note };
}

function grade(score) {
  if (score >= 70) return "高";
  if (score >= 45) return "中";
  return "低";
}

// Main entry point. `features` must already be confirmed (Stage 0 requires user confirmation
// before this runs — caller/Agent is responsible for that gate, this function just computes).
function computeScore({ cutoffDate, cutoffYear, subtechLabel, features, priorArt, literature, targetJurisdiction }) {
  const all = corpus.loadRawCorpus();
  const cutoffPatents = corpus.filterByCutoff(all, cutoffDate);

  const novelty = noveltyFactor(features, priorArt);
  const crowding = crowdingFactor(cutoffPatents, subtechLabel);
  const temporal = temporalFactor(literature, cutoffYear, cutoffPatents, subtechLabel);
  const regional = regionalFactor(cutoffPatents, subtechLabel, targetJurisdiction);

  const factors = [
    { factor: "novelty", label: "Novelty 新穎性", ...novelty },
    { factor: "crowding", label: "Crowding 擁擠度", ...crowding },
    { factor: "temporal", label: "Temporal 時間差", ...temporal },
    { factor: "regional", label: "Regional 區域缺口", ...regional },
  ];

  const breakdown = factors.map((f) => {
    const weight = WEIGHTS[f.factor];
    const weighted = Math.round(f.value * weight * 100 * 10) / 10;
    return { factor: f.factor, label: f.label, value: Math.round(f.value * 100) / 100, weight, weighted, note: f.note };
  });

  const score = Math.round(breakdown.reduce((sum, f) => sum + f.weighted, 0));

  return {
    score,
    grade: grade(score),
    breakdown,
    corpus_meta: corpus.corpusMeta(cutoffDate),
    whitespace: corpus.whitespaceSignal(cutoffPatents).slice(0, 20),
  };
}

module.exports = { computeScore, WEIGHTS, grade };
