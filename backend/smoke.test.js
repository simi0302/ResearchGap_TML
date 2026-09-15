// Smoke tests for POST /api/patentability logic, mirroring §⑧ of
// ResearchGap_Agent_Skill_v2.md. Run with: node --test
const test = require("node:test");
const assert = require("node:assert/strict");
const { handlePatentabilityRequest } = require("./patentability");

test("upload mode without a year asks for cutoff confirmation first (Stage 0)", () => {
  const r = handlePatentabilityRequest({ mode: "upload", text: "A paper about SDN controllers." });
  assert.equal(r.needs_confirmation, "cutoff_year");
  assert.equal(r.score, undefined);
});

test("upload mode with a year but no features asks for feature confirmation before scoring", () => {
  const r = handlePatentabilityRequest({
    mode: "upload",
    publication_year: 2022,
    text: "An intent-based SDN controller for network slicing orchestration.",
  });
  assert.equal(r.needs_confirmation, "features");
  assert.ok(Array.isArray(r.extracted_features) && r.extracted_features.length > 0);
  assert.equal(r.score, undefined);
});

test("upload mode with confirmed features returns a real POS score with all four factors", () => {
  const r = handlePatentabilityRequest({
    mode: "upload",
    publication_year: 2022,
    features: [
      { id: "F1", text: "intent-based slice provisioning", ipc: "H04L 41" },
      { id: "F2", text: "SDN controller", ipc: "H04L 45" },
    ],
  });
  assert.equal(r.cutoff_date, "2022-12-31");
  assert.equal(r.breakdown.length, 4);
  const factorNames = r.breakdown.map((f) => f.factor).sort();
  assert.deepEqual(factorNames, ["crowding", "novelty", "regional", "temporal"]);
  assert.ok(r.score >= 0 && r.score <= 100);
  assert.ok(["高", "中", "低"].includes(r.grade));
  // no prior_art supplied -> novelty must fall back to the neutral value with a note,
  // never a guessed number.
  const novelty = r.breakdown.find((f) => f.factor === "novelty");
  assert.equal(novelty.value, 0.5);
  assert.match(novelty.note, /尚無前案比對資料/);
});

test("corpus mode only uses patents published on/before the reference patent's filing date", () => {
  const r = handlePatentabilityRequest({ mode: "corpus", patent_id: "TW202529425A" });
  assert.equal(r.cutoff_date, "2024-01-12");
  assert.ok(r.corpus_meta.n_before_cutoff < r.corpus_meta.n, "cutoff filtering must shrink the corpus");
  assert.ok(r.corpus_meta.n_before_cutoff > 0);
});

test("corpus mode rejects an unknown publication_number instead of fabricating a result", () => {
  const r = handlePatentabilityRequest({ mode: "corpus", patent_id: "NOT-A-REAL-ID" });
  assert.ok(r.error);
  assert.equal(r.score, undefined);
});

test("caller cannot inject a score — the field is silently ignored, backend always recomputes", () => {
  const r = handlePatentabilityRequest({
    mode: "upload",
    publication_year: 2022,
    features: [{ id: "F1", text: "x", ipc: "H04L 41" }],
    score: 999,
  });
  assert.notEqual(r.score, 999);
  assert.ok(r.score >= 0 && r.score <= 100);
});

test("crowding and regional are always computed from the real corpus, never neutral placeholders", () => {
  const r = handlePatentabilityRequest({
    mode: "upload",
    publication_year: 2022,
    features: [{ id: "F1", text: "x", ipc: "H04L 45" }],
  });
  const crowding = r.breakdown.find((f) => f.factor === "crowding");
  const regional = r.breakdown.find((f) => f.factor === "regional");
  assert.doesNotMatch(crowding.note, /中性值 0\.5/);
  assert.doesNotMatch(regional.note, /中性值 0\.5/);
});
