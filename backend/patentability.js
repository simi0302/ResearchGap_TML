// Request-level orchestration for POST /api/patentability — implements the "基準日鐵律"
// and Stage 0 confirmation gate from §③ before any score is computed, then calls scoring.js.
// Kept separate from server.js so it can be unit-tested without spinning up Express.
const corpus = require("./corpus");
const features = require("./features");
const scoring = require("./scoring");

function toCutoffDateFromYear(year) {
  return `${year}-12-31`;
}

function subtechFromFeatures(feats) {
  const counts = new Map();
  for (const f of feats) {
    if (!f.ipc) continue;
    counts.set(f.ipc, (counts.get(f.ipc) || 0) + 1);
  }
  if (counts.size === 0) return "OTHER";
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

// body: see §④ schema. Returns either
//   { needs_confirmation: "cutoff_year" | "features", ... }   (Stage 0, not scored yet)
// or the full §④ result object (scored).
function handlePatentabilityRequest(body) {
  const mode = body.mode === "corpus" ? "corpus" : "upload";

  if (mode === "corpus") {
    const patentId = body.patent_id;
    if (!patentId) return { error: "corpus 模式需要 patent_id（母體專利的 publication_number）。" };
    const ref = corpus.findByPublicationNumber(patentId);
    if (!ref) return { error: `找不到 publication_number = ${patentId} 的母體專利。` };
    const cutoffDate = ref.filing_date; // §③: 母體專利模式以該母體專利的申請日為基準日
    const cutoffYear = Number(String(cutoffDate).slice(0, 4));
    const feats = (ref.ipc.length ? ref.ipc : ["UNCLASSIFIED"]).map((code, i) => ({
      id: `F${i + 1}`,
      text: `${ref.title}（IPC ${corpus.ipcMainGroup(code)}）`,
      ipc: corpus.ipcMainGroup(code),
    }));
    return scoreWithFeatures({ body, cutoffDate, cutoffYear, feats, caseId: patentId });
  }

  // upload mode. 2026-09-17: previously this always stopped and asked the user to
  // confirm the cutoff year, then stopped again to confirm the feature list — two
  // required round trips before any analysis appeared. User feedback: "不需要使用者
  // 分次回應，就一次產出長篇分析就好啊" (don't make the user respond in stages, just
  // produce one rich analysis in one go). Now: auto-detect and proceed straight to a
  // score whenever the real document text gives *any* signal (still fully
  // deterministic/reproducible from the real text — see features.pickCutoffYear /
  // extractFeatures — never a model guess); only stop and ask when detection is truly
  // empty (no year mentioned anywhere, or zero known vocabulary matched), since there's
  // nothing real to auto-pick in that case. Every auto-picked value is flagged
  // (auto_detected_cutoff_year / auto_detected_features) so the caller can disclose it
  // and the user can still correct it — 基準日鐵律 stays intact, it just isn't a
  // blocking round trip when the document already answers the question.
  const text = body.text || "";
  let cutoffYear = body.publication_year;
  let autoDetectedCutoffYear = false;
  if (!cutoffYear) {
    const picked = features.pickCutoffYear(text);
    if (picked === null) {
      return {
        needs_confirmation: "cutoff_year",
        candidates: [],
        message: "無法從文字中偵測到年份，請使用者提供發表年以設定基準日。",
      };
    }
    cutoffYear = picked;
    autoDetectedCutoffYear = true;
  }
  cutoffYear = Number(cutoffYear);
  const cutoffDate = toCutoffDateFromYear(cutoffYear);
  const yearCandidates = features.suggestPublicationYears(text);

  let feats = body.features;
  let autoDetectedFeatures = false;
  if (!feats || feats.length === 0) {
    const extracted = features.extractFeatures(text);
    if (extracted.length === 0) {
      return {
        needs_confirmation: "features",
        cutoff_year: cutoffYear,
        cutoff_date: cutoffDate,
        auto_detected_cutoff_year: autoDetectedCutoffYear,
        year_candidates: yearCandidates,
        message: "後端無法從文字中拆解出任何已知技術特徵關鍵字，請使用者補充技術特徵描述。",
      };
    }
    feats = extracted;
    autoDetectedFeatures = true;
  }

  const result = scoreWithFeatures({ body, cutoffDate, cutoffYear, feats, caseId: body.case_id || `U-${Date.now()}` });
  return {
    ...result,
    auto_detected_cutoff_year: autoDetectedCutoffYear,
    year_candidates: autoDetectedCutoffYear ? yearCandidates : undefined,
    auto_detected_features: autoDetectedFeatures,
  };
}

function scoreWithFeatures({ body, cutoffDate, cutoffYear, feats, caseId }) {
  const subtechLabel = subtechFromFeatures(feats);
  const result = scoring.computeScore({
    cutoffDate,
    cutoffYear,
    subtechLabel,
    features: feats,
    priorArt: Array.isArray(body.prior_art) ? body.prior_art : [],
    literature: Array.isArray(body.literature) ? body.literature : [],
    targetJurisdiction: typeof body.target_jurisdiction === "string" ? body.target_jurisdiction : undefined,
  });

  return {
    mode: body.mode === "corpus" ? "corpus" : "upload",
    case_id: caseId,
    cutoff_year: cutoffYear,
    cutoff_date: cutoffDate,
    subtech_label: subtechLabel,
    features: feats,
    score: result.score,
    grade: result.grade,
    breakdown: result.breakdown,
    prior_art: Array.isArray(body.prior_art) ? body.prior_art : [],
    literature: Array.isArray(body.literature) ? body.literature : [],
    whitespace: result.whitespace,
    combination_whitespace: result.combination_whitespace,
    corpus_meta: result.corpus_meta,
  };
}

module.exports = { handlePatentabilityRequest };
