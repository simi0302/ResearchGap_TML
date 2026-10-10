// Known-item retrieval: a corpus patent's own text, submitted as an upload, must retrieve that
// patent (or another publication of the same invention) among the top 5 prior art, and must
// never retrieve it when the cutoff is before its publication. Guards the document-term
// hybrid query (retrieval.documentTerms) — with feature labels alone this was 19% at top 5.
const test = require("node:test");
const assert = require("node:assert/strict");
const corpus = require("./corpus");
const retrieval = require("./retrieval");
const features = require("./features");

const sample = corpus
  .loadRawCorpus()
  .filter((p) => p.abstract && p.abstract.length > 300 && p.publication_date)
  .filter((_, i) => i % 41 === 0)
  .slice(0, 50);

test("documentTerms is deterministic and returns corpus vocabulary only", () => {
  const text = `${sample[0].title} ${sample[0].abstract}`;
  const a = retrieval.documentTerms(text);
  assert.deepEqual(a, retrieval.documentTerms(text));
  assert.ok(a.length > 0 && a.length <= 20);
  assert.deepEqual(retrieval.documentTerms("zzqx qqzz"), []);
});

test("a patent's own text retrieves it within the top 5 (same invention counts) and never before its publication", () => {
  let hits = 0;
  let scored = 0;
  for (const p of sample) {
    const text = `${p.title}\n\n${p.abstract}`;
    const feats = features.extractFeatures(text);
    if (feats.filter((f) => f.feature_id).length < 2) continue;
    scored++;
    const terms = retrieval.documentTerms(text);
    const after = retrieval.searchPriorArt(feats, p.publication_date, 5, [], terms);
    const same = (x) => x.patent_no === p.publication_number || x.title.trim().toLowerCase() === p.title.trim().toLowerCase();
    if (after.some(same)) hits++;
    const year = Number(p.publication_date.slice(0, 4));
    const before = retrieval.searchPriorArt(feats, `${year - 1}-12-31`, 5, [], terms);
    assert.ok(!before.some((x) => x.patent_no === p.publication_number), `${p.publication_number} leaked before its publication`);
  }
  assert.ok(scored >= 15, `only ${scored} sample patents were scorable`);
  assert.ok(hits / scored >= 0.9, `known-item recall@5 ${hits}/${scored}`);
});
