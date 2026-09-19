// Request-level orchestration for POST /api/patentability. Implements the cutoff-date rule
// and the Stage 0 auto-detection gate before any score is computed, then calls scoring.js.
// Kept separate from server.js so it can be unit-tested without spinning up Express.
// Async because scoring now needs a real per-year literature count (literature.js →
// OpenAlex) before Temporal can be computed — see scoring.js's header comment.
const corpus = require("./corpus");
const features = require("./features");
const scoring = require("./scoring");
const literature = require("./literature");
const externalPriorArt = require("./externalPriorArt");
const { t } = require("./i18n");

const DEFAULT_LANG = process.env.DEFAULT_LANG === "zh" ? "zh" : "en";

function resolveLang(body) {
  return body?.lang === "zh" ? "zh" : body?.lang === "en" ? "en" : DEFAULT_LANG;
}

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

// body: see README's "Request/response shapes" section. Returns one of:
//   { needs_confirmation: "cutoff_year" | "features", ... }        (Stage 0, not scored)
//   { out_of_scope: true, reason: "insufficient" | "other", ... }  (P0-1 fix item 7, not scored)
//   { error: "..." }                                               (bad request)
//   the full scored result object
async function handlePatentabilityRequest(body) {
  const lang = resolveLang(body);
  const s = t(lang);
  const mode = body.mode === "corpus" ? "corpus" : "upload";

  if (mode === "corpus") {
    const patentId = body.patent_id;
    if (!patentId) return { error: s.errors.missingPatentId };
    const ref = corpus.findByPublicationNumber(patentId);
    if (!ref) return { error: s.errors.unknownPatentId(patentId) };
    const cutoffDate = ref.filing_date; // corpus mode: cutoff = the reference patent's own filing date
    const cutoffYear = Number(String(cutoffDate).slice(0, 4));
    const text = `${ref.title} ${ref.abstract}`;
    let feats = features.extractFeatures(text);
    if (feats.length === 0) {
      // Fall back to the reference patent's own IPC codes when its title/abstract don't
      // match any canonical feature term — still real data (the patent's own
      // classification), never invented.
      feats = (ref.ipc.length ? ref.ipc : ["UNCLASSIFIED"]).map((code, i) => ({
        id: `F${i + 1}`,
        text: `${ref.title} (IPC ${corpus.ipcMainGroup(code)})`,
        ipc: corpus.ipcMainGroup(code),
        feature_id: null,
      }));
    }
    return scoreWithFeatures({ body, lang, cutoffDate, cutoffYear, feats, caseId: patentId });
  }

  // Upload mode: auto-detect both the cutoff year and technical features directly from the
  // real document text and score in one shot whenever there's real signal — only stops to
  // ask when detection is truly empty (nothing real to auto-pick). See README for why this
  // isn't a multi-round-trip confirmation flow.
  const text = typeof body.text === "string" ? body.text : "";
  // Only a plausible patent-era year counts as a user-supplied cutoff; anything else falls
  // back to auto-detection instead of producing an "NaN-12-31" cutoff date.
  const requestedYear = Number(body.publication_year);
  let cutoffYear = Number.isInteger(requestedYear) && requestedYear >= 1990 && requestedYear <= 2030 ? requestedYear : undefined;
  let autoDetectedCutoffYear = false;
  let yearConfidence = "user";
  let yearSource = "user";
  if (!cutoffYear) {
    const detected = features.detectCutoffYear(text);
    if (detected === null) {
      return {
        needs_confirmation: "cutoff_year",
        candidates: [],
        message: s.needsConfirmationYear,
      };
    }
    cutoffYear = detected.year;
    yearConfidence = detected.confidence;
    yearSource = detected.source;
    autoDetectedCutoffYear = true;
  }
  cutoffYear = Number(cutoffYear);
  const cutoffDate = toCutoffDateFromYear(cutoffYear);
  const yearCandidates = features.suggestPublicationYears(text);

  // User-confirmed features are free text that later reaches web-search queries, so bound
  // their count and length and drop anything that isn't a plain {id, text} string pair.
  let feats = Array.isArray(body.features)
    ? body.features
        .filter((f) => f && typeof f.id === "string" && typeof f.text === "string" && f.text.trim())
        .slice(0, 12)
        .map((f) => ({ ...f, id: f.id.slice(0, 16), text: f.text.slice(0, 120) }))
    : undefined;
  let autoDetectedFeatures = false;
  if (!feats || feats.length === 0) {
    const extracted = features.extractFeatures(text);
    if (extracted.length === 0) {
      return {
        needs_confirmation: "features",
        cutoff_year: cutoffYear,
        cutoff_date: cutoffDate,
        auto_detected_cutoff_year: autoDetectedCutoffYear,
        year_confidence: yearConfidence,
        year_source: yearSource,
        year_candidates: yearCandidates,
        message: s.needsConfirmationFeatures,
      };
    }
    feats = extracted;
    autoDetectedFeatures = true;
  }

  const result = await scoreWithFeatures({ body, lang, cutoffDate, cutoffYear, feats, caseId: body.case_id || `U-${Date.now()}` });
  return {
    ...result,
    auto_detected_cutoff_year: autoDetectedCutoffYear,
    year_confidence: yearConfidence,
    year_source: yearSource,
    year_candidates: autoDetectedCutoffYear ? yearCandidates : undefined,
    auto_detected_features: autoDetectedFeatures,
  };
}

async function scoreWithFeatures({ body, lang, cutoffDate, cutoffYear, feats, caseId }) {
  const s = t(lang);
  const subtechLabel = subtechFromFeatures(feats);

  const reason = scoring.outOfScopeReason(feats, subtechLabel);
  if (reason) {
    return {
      out_of_scope: true,
      reason,
      case_id: caseId,
      cutoff_year: cutoffYear,
      cutoff_date: cutoffDate,
      subtech_label: subtechLabel,
      features: feats,
      message: reason === "other" ? s.outOfScope.other : s.outOfScope.insufficient,
    };
  }

  // Real per-year literature counts for Temporal (P0-1 fix item 5) — fetched here so both
  // POST /api/patentability and the compute_patentability tool call go through the exact
  // same deterministic pipeline, regardless of whether the model remembered to search first.
  const query = feats.slice(0, 4).map((f) => f.text).join(" ");
  const literatureYearCounts = await literature.fetchYearlyLiteratureCounts(query, cutoffYear - 4, cutoffYear);

  const targetJurisdiction = typeof body.target_jurisdiction === "string" ? body.target_jurisdiction.toUpperCase() : undefined;

  // Backend-fetched external patents (never taken from the request body or the model) join
  // the corpus for Novelty's prior-art search. Failure → [] and the corpus alone is used.
  const external = await externalPriorArt.fetchExternalPatents(feats, cutoffDate);

  const result = scoring.computeScore({
    externalPatents: external.patents,
    cutoffDate,
    cutoffYear,
    subtechLabel,
    features: feats,
    literatureYearCounts,
    targetJurisdiction,
    lang,
  });

  return {
    mode: body.mode === "corpus" ? "corpus" : "upload",
    case_id: caseId,
    cutoff_year: cutoffYear,
    cutoff_date: cutoffDate,
    subtech_label: subtechLabel,
    target_jurisdiction: scoring.VALID_JURISDICTIONS.includes(targetJurisdiction) ? targetJurisdiction : scoring.DEFAULT_TARGET_JURISDICTION,
    features: feats,
    score: result.score,
    grade: result.grade,
    breakdown: result.breakdown,
    insufficient_evidence: result.insufficient_evidence,
    disclaimer: result.disclaimer,
    prior_art: result.prior_art,
    external_prior_art: { used: external.patents.map((p) => p.publication_number), count: external.patents.length, note: external.note },
    whitespace: result.whitespace,
    combination_whitespace: result.combination_whitespace,
    corpus_meta: result.corpus_meta,
  };
}

module.exports = { handlePatentabilityRequest };
