// Deterministic in-corpus prior-art retrieval — replaces the dead Bing-search-backed
// "the model calls search_prior_art and hopes it finds something" path for Novelty (see
// P0-1/P0-5). Works immediately, no API key: a plain BM25 index over
// backend/data/patents.json's title+abstract, filtered to publication_date <= cutoff_date
// (基準日鐵律), queried with the case's own extracted features. matched_features for each
// result is computed here from the real patent text with the same word-boundary matcher
// features.js uses for the case document — never trusted from the model, so a model can't
// claim an overlap that isn't actually in the patent text.
const corpus = require("./corpus");
const features = require("./features");

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "for", "in", "to", "with", "based", "method", "methods",
  "system", "systems", "device", "devices", "apparatus", "apparatuses", "using", "via", "from",
  "on", "by", "its", "into", "at", "is", "are", "be", "same", "such", "thereof", "network", "networks",
  "networking", "non", "first", "second", "one", "more", "this", "that", "which", "not", "can",
  "may", "also", "each", "between", "over", "than", "then", "as", "it", "their", "these",
]);

function tokenize(text) {
  return (String(text || "").toLowerCase().match(/[a-z][a-z0-9-]{2,}/g) || []).filter((t) => !STOPWORDS.has(t));
}

function vectorize(p) {
  const tokens = tokenize(`${p.title} ${p.abstract}`);
  const tf = new Map();
  for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
  return { patent: p, tf, len: tokens.length };
}

let _docVectors = null;
function buildDocVectors() {
  if (_docVectors) return _docVectors;
  _docVectors = corpus.loadRawCorpus().map(vectorize);
  return _docVectors;
}

const BM25_K1 = 1.5;
const BM25_B = 0.75;

// Okapi BM25 over the cutoff-filtered subset, with IDF recomputed within that subset (not
// the whole corpus) — a term's rarity should be judged against what was actually public
// as-of the cutoff, not against patents that didn't exist yet.
function bm25Search(queryTokens, cutoffDate, limit = 5, extraPatents = []) {
  const all = extraPatents.length ? [...buildDocVectors(), ...extraPatents.map(vectorize)] : buildDocVectors();
  const subset = cutoffDate ? all.filter((d) => d.patent.publication_date && d.patent.publication_date <= cutoffDate) : all;
  const N = subset.length;
  if (N === 0 || queryTokens.length === 0) return [];

  const avgdl = subset.reduce((s, d) => s + d.len, 0) / N;
  const qTokens = [...new Set(queryTokens)];
  const df = new Map();
  for (const t of qTokens) {
    let c = 0;
    for (const d of subset) if (d.tf.has(t)) c++;
    df.set(t, c);
  }

  const scored = [];
  for (const d of subset) {
    let score = 0;
    for (const t of qTokens) {
      const f = d.tf.get(t) || 0;
      if (f === 0) continue;
      const dft = df.get(t) || 0;
      const idf = Math.log(1 + (N - dft + 0.5) / (dft + 0.5));
      score += idf * ((f * (BM25_K1 + 1)) / (f + BM25_K1 * (1 - BM25_B + BM25_B * (d.len / avgdl))));
    }
    if (score > 0) scored.push({ patent: d.patent, score });
  }
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, limit);
  const maxScore = top.length ? top[0].score : 0;
  return top.map((x) => ({ patent: x.patent, similarity: maxScore > 0 ? x.score / maxScore : 0 }));
}

// Query text: each case feature's own label plus its canonical taxonomy terms (richer
// signal than the label alone, and consistent across runs since it's derived from
// features.js's fixed FEATURE_DEFS, not the free-text document).
const FEATURE_BY_ID = new Map(features.FEATURE_DEFS.map((f) => [f.id, f]));
function queryTokensForFeatures(caseFeatures) {
  const tokens = [];
  for (const f of caseFeatures) {
    tokens.push(...tokenize(f.text));
    const def = f.feature_id ? FEATURE_BY_ID.get(f.feature_id) : null;
    if (def) {
      for (const p of def.phrases) tokens.push(...tokenize(p));
      for (const a of def.acronyms) tokens.push(...tokenize(a));
    }
  }
  return tokens;
}

// Which of the case's own feature ids (F1, F2, ...) are actually present in a given
// patent's real text — computed with the same word-boundary matcher as the case
// document, so this can never be inflated by a model-supplied claim.
function matchedFeatureIdsForPatent(patent, caseFeatures) {
  const present = features.matchFeaturesInText(`${patent.title} ${patent.abstract}`);
  return caseFeatures.filter((f) => f.feature_id && present.has(f.feature_id)).map((f) => f.id);
}

// Top-N in-corpus prior art for a case's features, filtered to publication_date <=
// cutoffDate. Returns [{patent_no, title, year, jurisdiction, similarity, matched_features}],
// highest similarity first. Empty array (not an error) when nothing matches at all —
// caller (scoring.js) is responsible for falling back to the neutral Novelty value and
// flagging is_fallback in that case.
// extraPatents: backend-fetched external patents (externalPriorArt.js), searched together
// with the corpus. Each result carries source: "corpus" | "external".
function searchPriorArt(caseFeatures, cutoffDate, limit = 5, extraPatents = []) {
  const queryTokens = queryTokensForFeatures(caseFeatures);
  const hits = bm25Search(queryTokens, cutoffDate, limit, extraPatents);
  return hits.map((h) => ({
    patent_no: h.patent.publication_number,
    title: h.patent.title,
    source: h.patent.source === "external" ? "external" : "corpus",
    year: h.patent.publication_date ? Number(String(h.patent.publication_date).slice(0, 4)) : null,
    jurisdiction: h.patent.jurisdiction,
    similarity: Math.round(h.similarity * 1000) / 1000,
    matched_features: matchedFeatureIdsForPatent(h.patent, caseFeatures),
  }));
}

module.exports = { searchPriorArt, matchedFeatureIdsForPatent, tokenize };
