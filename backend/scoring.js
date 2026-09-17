// POS (Patentability Opportunity Score) — four-factor formula, each sub-score normalized to
// 0-1, weighted and summed to 0-100 (see WEIGHTS below). Every input is either read straight
// from the real patent corpus (backend/data/patents.json) or fetched by the backend itself
// (in-corpus BM25 retrieval for Novelty via retrieval.js, real per-year literature counts for
// Temporal via tools.js's OpenAlex call, passed in as literatureYearCounts) — never computed,
// judged, or supplied by the LLM. See README's "Scoring formulas" section for the full spec
// this file implements, and P0-1 in the engineering log for the root causes this rewrite fixes
// (every case scoring ~30/100 regardless of content).
const corpus = require("./corpus");
const features = require("./features");
const retrieval = require("./retrieval");
const { t } = require("./i18n");

const WEIGHTS = {
  novelty: 0.40,
  crowding: 0.25,
  temporal: 0.20,
  regional: 0.15,
};

const VALID_JURISDICTIONS = ["US", "EP", "JP", "TW"];
const DEFAULT_TARGET_JURISDICTION = process.env.DEFAULT_TARGET_JURISDICTION || "TW";

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}

function jaccard(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 1;
  const inter = [...setA].filter((x) => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : inter / union;
}

// Novelty = 0.5×(1 − max Jaccard vs top-5 in-corpus prior art) + 0.5×(unmatched features ÷
// total features). priorArt comes from retrieval.searchPriorArt() — deterministic BM25 over
// the real corpus, matched_features computed by the backend from the patent's own text (see
// retrieval.js), never trusted from a model. Falls back to a neutral 0.5 ONLY when retrieval
// genuinely returns nothing for this cutoff/feature set (e.g. a brand-new combination with no
// comparable prior art before the cutoff) — flagged is_fallback so the UI can grey it out.
function noveltyFactor(caseFeatures, priorArt, lang) {
  const s = t(lang);
  if (!priorArt || priorArt.length === 0) {
    return { value: 0.5, note: s.novelty.fallback, is_fallback: true, evidence_count: 0 };
  }
  const caseIds = new Set(caseFeatures.map((f) => f.id));
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
  const total = caseFeatures.length || 1;
  const unmatched = caseFeatures.filter((f) => !matchedAnywhere.has(f.id)).length;

  const value = 0.5 * clamp01(1 - maxJ) + 0.5 * clamp01(unmatched / total);
  const note = s.novelty.withData(closest?.patent_no || "(unlabeled)", Math.round(maxJ * 100), unmatched, caseFeatures.length);
  return { value, note, is_fallback: false, evidence_count: top5.length };
}

// Which cutoff-filtered patents match at least 2 of the case's own canonical features
// (feature_id, not the per-case F# id) — this is the "matched set" Crowding, Regional, and
// Temporal all key off, instead of the old IPC-main-group population (which collapsed
// unrelated documents into the same oversized bucket — see P0-1 root cause (b)).
function matchedSetForCase(caseFeatureIds, cutoffPatents) {
  const index = features.buildPatentFeatureIndex();
  const cutoffSet = new Set(cutoffPatents);
  const matched = [];
  for (const rec of index) {
    if (!cutoffSet.has(rec.patent)) continue;
    let count = 0;
    for (const fid of caseFeatureIds) if (rec.features.has(fid)) count++;
    if (count >= 2) matched.push(rec.patent);
  }
  return matched;
}

// Background distribution for the Crowding percentile: the same "≥2 features match" hit
// count, computed for every unordered pair of the full canonical taxonomy (features.js's
// FEATURE_DEFS), against the same cutoff-filtered corpus. Cached per cutoffDate since it's
// independent of any one case's own feature set.
const _pairwiseCountsCache = new Map();
function pairwiseBackgroundCounts(cutoffDate, cutoffPatents) {
  const key = cutoffDate || "__all__";
  if (_pairwiseCountsCache.has(key)) return _pairwiseCountsCache.get(key);
  const index = features.buildPatentFeatureIndex();
  const cutoffSet = new Set(cutoffPatents);
  const ids = features.FEATURE_DEFS.map((d) => d.id);
  const counts = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      let c = 0;
      for (const rec of index) {
        if (!cutoffSet.has(rec.patent)) continue;
        if (rec.features.has(ids[i]) && rec.features.has(ids[j])) c++;
      }
      counts.push(c);
    }
  }
  _pairwiseCountsCache.set(key, counts);
  return counts;
}

function percentileRank(value, backgroundArr) {
  if (backgroundArr.length === 0) return 0;
  let below = 0;
  let equal = 0;
  for (const v of backgroundArr) {
    if (v < value) below++;
    else if (v === value) equal++;
  }
  return (below + 0.5 * equal) / backgroundArr.length;
}

// Crowding = 1 − percentile rank of (patents before the cutoff matching ≥2 of the case's
// features) among the hit-counts of every pairwise combination of known technical features.
// This is feature-combination density, not IPC-group population — different documents that
// used to collapse into the same oversized IPC bucket (P0-1 root cause (b)) now land on
// genuinely different points of this distribution, because they match different feature
// pairs with genuinely different real-world densities.
function crowdingFactor(caseFeatureIds, cutoffDate, cutoffPatents, lang) {
  const s = t(lang);
  const matched = matchedSetForCase(caseFeatureIds, cutoffPatents);
  const hits = matched.length;
  const background = pairwiseBackgroundCounts(cutoffDate, cutoffPatents);
  const percentile = percentileRank(hits, background);
  const value = clamp01(1 - percentile);
  return {
    value,
    note: s.crowding.note(hits, Math.round(percentile * 100), background.length),
    matchedPatents: matched,
  };
}

// Regional = 0.5×(target jurisdiction has no matching filing before cutoff ? 1 : 0) +
// 0.5×(1 − applicant HHI ÷ 10000), both computed over the SAME feature-matched set as
// Crowding (not the whole IPC group) — so "regional gap" now means "no one has filed this
// specific feature combination here yet," not "no one has filed anything in this whole
// technology class here yet" (P0-1 root cause (c)). target_jurisdiction is a request
// parameter (US/EP/JP/TW); falls back to DEFAULT_TARGET_JURISDICTION (env-configurable) if
// omitted or not one of the four supported jurisdictions.
function regionalFactor(matchedPatents, targetJurisdiction, lang) {
  const s = t(lang);
  const target = VALID_JURISDICTIONS.includes(targetJurisdiction) ? targetJurisdiction : DEFAULT_TARGET_JURISDICTION;
  const targetHits = matchedPatents.filter((p) => p.jurisdiction === target).length;
  const gapTerm = targetHits === 0 ? 1 : 0;

  const counts = new Map();
  for (const p of matchedPatents) {
    const applicant = (p.assignees && p.assignees[0]) || p.company_name || "unknown";
    counts.set(applicant, (counts.get(applicant) || 0) + 1);
  }
  const total = matchedPatents.length;
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
  const concentrationValue = total ? clamp01(1 - hhi / 10000) : 0.5;
  const concentrationNote = s.regional.concentration(total, Math.round(hhi), topApplicant, Math.round(topShare * 100));
  const value = 0.5 * gapTerm + 0.5 * concentrationValue;
  const note = s.regional.note(target, targetHits, gapTerm, concentrationNote);
  return { value, note, target, is_fallback: total === 0, evidence_count: total };
}

// Temporal = growth of REAL per-year literature counts over [cutoffYear-4 .. cutoffYear]
// (literatureYearCounts: {year: count}, fetched by tools.js from OpenAlex's
// group_by=publication_year — real totals, not the size of a ~5-10-item search-hit page —
// see P0-1 root cause (d)); halved if the matched-set patent count in the same window
// exceeds the literature count. Falls back to neutral 0.5, flagged is_fallback, only when no
// real per-year data could be fetched at all.
function temporalFactor(literatureYearCounts, matchedPatents, cutoffYear, lang) {
  const s = t(lang);
  if (!literatureYearCounts || Object.keys(literatureYearCounts).length === 0) {
    return { value: 0.5, note: s.temporal.fallback, is_fallback: true, evidence_count: 0 };
  }
  const y0 = cutoffYear - 4;
  const y1 = cutoffYear;
  const years = [];
  for (let y = y0; y <= y1; y++) years.push(y);
  const litByYear = years.map((y) => literatureYearCounts[y] || 0);
  if (litByYear.every((v) => v === 0)) {
    return { value: 0.5, note: s.temporal.fallback, is_fallback: true, evidence_count: 0 };
  }
  const first = litByYear[0];
  const last = litByYear[litByYear.length - 1];
  const growth = first > 0 ? (last - first) / first : last > 0 ? 1 : 0;
  let value = clamp01(0.5 + growth / 2);

  const patByYear = years.map(
    (y) => matchedPatents.filter((p) => Number(String(p.publication_date || "").slice(0, 4)) === y).length
  );
  const litSum = litByYear.reduce((a, b) => a + b, 0);
  const patSum = patByYear.reduce((a, b) => a + b, 0);
  let halved = false;
  if (patSum > litSum) {
    value *= 0.5;
    halved = true;
  }
  const note = s.temporal.note(y0, y1, first, last, halved, patSum, litSum);
  return { value, note, is_fallback: false, evidence_count: litSum };
}

function gradeFor(score, lang) {
  const g = t(lang).grade;
  if (score >= 70) return g.high;
  if (score >= 45) return g.medium;
  return g.low;
}

// Out-of-scope gate (P0-1 fix item 7): fewer than 2 in-scope features, or the case's
// dominant IPC group is "OTHER" (not one of the corpus's known sub-technology groups), means
// there isn't enough real signal to score honestly — return a reason instead of a number.
// Called by patentability.js BEFORE computeScore(); computeScore itself assumes its caller
// already enforced this (it does not re-check).
function outOfScopeReason(caseFeatures, subtechLabel) {
  const inScope = caseFeatures.filter((f) => f.feature_id).length;
  if (inScope < 2) return "insufficient";
  if (subtechLabel === "OTHER") return "other";
  return null;
}

// Main entry point. `caseFeatures` must already be confirmed/extracted (features.js) and
// pass the outOfScopeReason() gate — this function just computes.
function computeScore({ cutoffDate, cutoffYear, subtechLabel, features: caseFeatures, literatureYearCounts, targetJurisdiction, lang }) {
  const all = corpus.loadRawCorpus();
  const cutoffPatents = corpus.filterByCutoff(all, cutoffDate);

  const priorArt = retrieval.searchPriorArt(caseFeatures, cutoffDate, 5);
  const caseFeatureIds = [...new Set(caseFeatures.map((f) => f.feature_id).filter(Boolean))];

  const novelty = noveltyFactor(caseFeatures, priorArt, lang);
  const crowding = crowdingFactor(caseFeatureIds, cutoffDate, cutoffPatents, lang);
  const regional = regionalFactor(crowding.matchedPatents, targetJurisdiction, lang);
  const temporal = temporalFactor(literatureYearCounts, crowding.matchedPatents, cutoffYear, lang);

  const s = t(lang);
  const factorDefs = [
    { factor: "novelty", label: s.factorLabels.novelty, ...novelty },
    { factor: "crowding", label: s.factorLabels.crowding, value: crowding.value, note: crowding.note, is_fallback: false, evidence_count: crowding.matchedPatents.length },
    { factor: "temporal", label: s.factorLabels.temporal, ...temporal },
    { factor: "regional", label: s.factorLabels.regional, value: regional.value, note: regional.note, is_fallback: regional.is_fallback, evidence_count: regional.evidence_count },
  ];

  const breakdown = factorDefs.map((f) => {
    const weight = WEIGHTS[f.factor];
    const weighted = Math.round(f.value * weight * 100 * 10) / 10;
    return {
      factor: f.factor,
      label: f.label,
      value: Math.round(f.value * 100) / 100,
      weight,
      weighted,
      note: f.note,
      is_fallback: Boolean(f.is_fallback),
      evidence_count: f.evidence_count || 0,
    };
  });

  const score = Math.round(breakdown.reduce((sum, f) => sum + f.weighted, 0));
  const fallbackCount = breakdown.filter((f) => f.is_fallback).length;

  return {
    score,
    grade: gradeFor(score, lang),
    breakdown,
    insufficient_evidence: fallbackCount >= 2,
    disclaimer: s.disclaimer,
    prior_art: priorArt,
    corpus_meta: corpus.corpusMeta(cutoffDate),
    whitespace: corpus.whitespaceSignal(cutoffPatents).slice(0, 20),
    combination_whitespace: corpus.combinationWhitespace(cutoffPatents, subtechLabel),
  };
}

// P1 item 9: re-rank a case under each weight ±5%/±10% and report whether the grade
// changes. Reuses the already-computed factor values from a normal computeScore() result
// (breakdown[].value) — perturbing a weight doesn't change what Novelty/Crowding/Temporal/
// Regional themselves measured, only how they're combined, so this needs no extra corpus
// scan or network call. Each perturbation adjusts one factor's weight and rescales the
// other three proportionally so all four still sum to 1.
const SENSITIVITY_DELTAS = [-0.10, -0.05, 0.05, 0.10];

function sensitivityAnalysis(breakdown, lang) {
  const baseScore = Math.round(breakdown.reduce((sum, f) => sum + f.weighted, 0));
  const baseGrade = gradeFor(baseScore, lang);

  const perturbations = [];
  for (const target of breakdown) {
    for (const delta of SENSITIVITY_DELTAS) {
      const newTargetWeight = clamp01(target.weight + delta);
      const othersWeightSum = 1 - target.weight;
      const scale = othersWeightSum > 0 ? (1 - newTargetWeight) / othersWeightSum : 0;
      let score = 0;
      for (const f of breakdown) {
        const w = f.factor === target.factor ? newTargetWeight : f.weight * scale;
        score += f.value * w * 100;
      }
      score = Math.round(score);
      const grade = gradeFor(score, lang);
      perturbations.push({
        factor: target.factor,
        base_weight: target.weight,
        adjusted_weight: Math.round(newTargetWeight * 1000) / 1000,
        delta,
        score,
        grade,
        grade_changed: grade !== baseGrade,
      });
    }
  }

  return {
    base_score: baseScore,
    base_grade: baseGrade,
    perturbations,
    robust: perturbations.every((p) => !p.grade_changed),
  };
}

module.exports = { computeScore, outOfScopeReason, sensitivityAnalysis, WEIGHTS, VALID_JURISDICTIONS, DEFAULT_TARGET_JURISDICTION };
