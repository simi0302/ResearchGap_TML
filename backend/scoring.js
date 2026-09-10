// The "可專利性初判分數" five-factor formula from §⑤ of ResearchGap_Agent_Skill_v2.md.
// Score = 100 × Σ(weight_i × factor_i), each factor normalized to 0–1.
// novelty / feature_uniqueness need prior art the Agent found on the web (per the spec's
// data flow: Agent searches → backend scores). Until prior_art is supplied, those two
// factors are held at a neutral 0.5 with a note — never guessed, per the anti-fabrication
// guardrail. prior_art_density and applicant_concentration are always computable from the
// real corpus. literature_maturity needs Agent-supplied literature[]; this repo has no
// real per-year literature counts (see frontend/README.md "目前刻意沒有做的部分"), so
// without literature[] it also falls back to 0.5 with an explicit note, exactly as §⑤ specifies.
const corpus = require("./corpus");

const WEIGHTS = {
  novelty: 0.35,
  feature_uniqueness: 0.20,
  prior_art_density: 0.20,
  literature_maturity: 0.15,
  applicant_concentration: 0.10,
};

function jaccard(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 1;
  const inter = [...setA].filter((x) => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : inter / union;
}

// prior_art: [{patent_no, year, matched_features: ["F1","F3", ...]}], up to top-5 by similarity
// used per spec ("前案取相似度前 5 名"). matched_features are feature ids the Agent judged as
// present/overlapping in that prior-art document.
function noveltyFactor(features, priorArt) {
  if (!priorArt || priorArt.length === 0) {
    return { value: 0.5, note: "尚無前案比對資料（待 Agent 全網路廣蒐後回傳 prior_art[]），因子暫定中性值 0.5。" };
  }
  const caseIds = new Set(features.map((f) => f.id));
  const top5 = priorArt.slice(0, 5);
  let maxJ = 0;
  let closest = null;
  for (const pa of top5) {
    const paIds = new Set(pa.matched_features || []);
    const j = jaccard(caseIds, paIds);
    if (j >= maxJ) {
      maxJ = j;
      closest = pa;
    }
  }
  const value = Math.max(0, Math.min(1, 1 - maxJ));
  const note = closest
    ? `與最接近前案 ${closest.patent_no || "(未標號)"} 的特徵重疊度 ${(maxJ * 100).toFixed(0)}%。`
    : "前案清單為空，視為無重疊。";
  return { value, note };
}

function featureUniquenessFactor(features, priorArt) {
  if (!priorArt || priorArt.length === 0) {
    return { value: 0.5, note: "尚無前案比對資料，因子暫定中性值 0.5。" };
  }
  const matchedAnywhere = new Set();
  for (const pa of priorArt) for (const fid of pa.matched_features || []) matchedAnywhere.add(fid);
  const total = features.length || 1;
  const unmatched = features.filter((f) => !matchedAnywhere.has(f.id)).length;
  const value = Math.max(0, Math.min(1, unmatched / total));
  return { value, note: `${features.length} 項特徵中有 ${unmatched} 項未見於任一提供的前案。` };
}

// literature: [{year, ...}] from Agent's web search (§④). Growth normalized over the most
// recent 3 years present in the (cutoff-filtered) list.
function literatureMaturityFactor(literature, cutoffYear) {
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
    return { value: 0.5, note: "提供的文獻年份不足以計算年增率，因子暫定中性值 0.5。" };
  }
  const recentYears = years.slice(-3);
  const first = byYear.get(recentYears[0]);
  const last = byYear.get(recentYears[recentYears.length - 1]);
  const growth = first > 0 ? (last - first) / first : last > 0 ? 1 : 0;
  const value = Math.max(0, Math.min(1, 0.5 + growth / 2));
  return { value, note: `近 ${recentYears.length} 年（${recentYears[0]}–${recentYears[recentYears.length - 1]}）文獻數由 ${first} 增至 ${last}。` };
}

function grade(score) {
  if (score >= 70) return "高";
  if (score >= 45) return "中";
  return "低";
}

// Main entry point. `features` must already be confirmed (Stage 0 requires user confirmation
// before this runs — caller/Agent is responsible for that gate, this function just computes).
function computeScore({ cutoffDate, cutoffYear, subtechLabel, features, priorArt, literature }) {
  const all = corpus.loadRawCorpus();
  const cutoffPatents = corpus.filterByCutoff(all, cutoffDate);

  const novelty = noveltyFactor(features, priorArt);
  const uniqueness = featureUniquenessFactor(features, priorArt);
  const density = corpus.priorArtDensityFactor(cutoffPatents, subtechLabel);
  const maturity = literatureMaturityFactor(literature, cutoffYear);
  const concentration = corpus.applicantConcentrationFactor(cutoffPatents, subtechLabel);

  const factors = [
    { factor: "novelty", ...novelty },
    { factor: "feature_uniqueness", ...uniqueness },
    { factor: "prior_art_density", ...density },
    { factor: "literature_maturity", ...maturity },
    { factor: "applicant_concentration", ...concentration },
  ];

  const breakdown = factors.map((f) => {
    const weight = WEIGHTS[f.factor];
    const weighted = Math.round(f.value * weight * 100 * 10) / 10;
    return { factor: f.factor, value: Math.round(f.value * 100) / 100, weight, weighted, note: f.note };
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
