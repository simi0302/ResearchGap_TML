// Novelty must be monotone in the evidence: adding backend-verified external / knowledge-base
// patents can reveal more overlap, never less. E7 (2026-10-11) found the opposite for 2 of 12
// papers when all patents shared one BM25 top 5; the evidence set is now corpus top 5 + external
// top 5, so the corpus part is unchanged by whatever external prior art is added.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const scoring = require("./scoring");
const corpus = require("./corpus");
const { extractFeatures } = require("./features");

const FIXTURES = ["oran-federated-ric.txt", "sfc-p4-zerotouch.txt", "slicing-digital-twin.txt", "5gcore-zerotrust.txt", "mature-openflow-basic.txt"];

// External candidates that reuse the corpus's own wording (strong BM25 competitors) — the
// situation that used to displace closer corpus patents.
function externalPool(cutoffDate) {
  return corpus
    .loadRawCorpus()
    .filter((p) => p.publication_date <= cutoffDate)
    .slice(0, 40)
    .map((p, i) => ({ ...p, publication_number: `XX${9000000 + i}`, source: "external" }));
}

test("adding external prior art never raises Novelty, and the corpus top 5 stays in the evidence", () => {
  const cutoffDate = "2023-12-31";
  for (const name of FIXTURES) {
    const text = fs.readFileSync(path.join(__dirname, "fixtures", name), "utf-8");
    const feats = extractFeatures(text);
    if (feats.length < 2) continue;
    const args = { cutoffDate, cutoffYear: 2023, subtechLabel: "H04L 41", features: feats, literatureYearCounts: {}, fieldYearCounts: {}, lang: "en" };
    const without = scoring.computeScore(args);
    const withExt = scoring.computeScore({ ...args, externalPatents: externalPool(cutoffDate) });
    const nov = (r) => r.breakdown.find((b) => b.factor === "novelty").value;
    assert.ok(nov(withExt) <= nov(without), `${name}: novelty rose from ${nov(without)} to ${nov(withExt)}`);
    const corpusTop = without.prior_art.map((p) => p.patent_no);
    assert.deepEqual(withExt.prior_art.filter((p) => p.source === "corpus").map((p) => p.patent_no), corpusTop, `${name}: corpus evidence changed`);
    assert.ok(withExt.prior_art.filter((p) => p.source === "external").length <= 5);
  }
});
