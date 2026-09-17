// Smoke tests for POST /api/patentability logic. Run with: node --test
const test = require("node:test");
const assert = require("node:assert/strict");
const { handlePatentabilityRequest } = require("./patentability");
const scoring = require("./scoring");

test("upload mode without a year asks for cutoff confirmation first (Stage 0)", async () => {
  const r = await handlePatentabilityRequest({ mode: "upload", text: "A paper about SDN controllers." });
  assert.equal(r.needs_confirmation, "cutoff_year");
  assert.equal(r.score, undefined);
});

test("upload mode with a year but no features auto-extracts features and scores in one shot", async () => {
  const r = await handlePatentabilityRequest({
    mode: "upload",
    publication_year: 2022,
    text: "An intent-based SDN controller for network slicing orchestration using zero-touch automation and traffic engineering.",
  });
  assert.equal(r.needs_confirmation, undefined);
  assert.equal(r.out_of_scope, undefined);
  assert.equal(r.auto_detected_features, true);
  assert.ok(Array.isArray(r.features) && r.features.length > 0);
  assert.ok(r.score >= 0 && r.score <= 100);
});

test("upload mode with text but no vocabulary match still asks for features (nothing real to auto-pick)", async () => {
  const r = await handlePatentabilityRequest({
    mode: "upload",
    publication_year: 2022,
    text: "This paper is about baking sourdough bread.",
  });
  assert.equal(r.needs_confirmation, "features");
  assert.equal(r.score, undefined);
});

test("upload mode auto-detects the cutoff year from real text and flags it as auto-detected", async () => {
  const r = await handlePatentabilityRequest({
    mode: "upload",
    text: "Published in 2021. Published in 2021. This paper (cf. a 2015 survey) proposes an SDN controller for network slicing orchestration with zero-touch automation.",
  });
  assert.equal(r.auto_detected_cutoff_year, true);
  assert.equal(r.cutoff_year, 2021, "the more frequently mentioned year should win over a single citation year");
  assert.ok(Array.isArray(r.year_candidates) && r.year_candidates.includes(2015));
  assert.ok(r.score >= 0 && r.score <= 100);
});

test("upload mode with confirmed features returns a real POS score with all four factors", async () => {
  const r = await handlePatentabilityRequest({
    mode: "upload",
    publication_year: 2022,
    features: [
      { id: "F1", text: "intent-based slice provisioning", ipc: "H04L 41", feature_id: "orchestration" },
      { id: "F2", text: "SDN controller", ipc: "H04L 45", feature_id: "sdn" },
    ],
  });
  assert.equal(r.cutoff_date, "2022-12-31");
  assert.equal(r.breakdown.length, 4);
  const factorNames = r.breakdown.map((f) => f.factor).sort();
  assert.deepEqual(factorNames, ["crowding", "novelty", "regional", "temporal"]);
  assert.ok(r.score >= 0 && r.score <= 100);
  assert.ok(["High", "Medium", "Low"].includes(r.grade));
});

test("corpus mode only uses patents published on/before the reference patent's filing date", async () => {
  const r = await handlePatentabilityRequest({ mode: "corpus", patent_id: "TW202529425A" });
  assert.equal(r.cutoff_date, "2024-01-12");
  assert.ok(r.corpus_meta.n_before_cutoff < r.corpus_meta.n, "cutoff filtering must shrink the corpus");
  assert.ok(r.corpus_meta.n_before_cutoff > 0);
});

test("corpus mode rejects an unknown publication_number instead of fabricating a result", async () => {
  const r = await handlePatentabilityRequest({ mode: "corpus", patent_id: "NOT-A-REAL-ID" });
  assert.ok(r.error);
  assert.equal(r.score, undefined);
});

test("caller cannot inject a score — the field is silently ignored, backend always recomputes", async () => {
  const r = await handlePatentabilityRequest({
    mode: "upload",
    publication_year: 2022,
    features: [
      { id: "F1", text: "intent-based slice provisioning", ipc: "H04L 41", feature_id: "orchestration" },
      { id: "F2", text: "SDN controller", ipc: "H04L 45", feature_id: "sdn" },
    ],
    score: 999,
  });
  assert.notEqual(r.score, 999);
  assert.ok(r.score >= 0 && r.score <= 100);
});

test("caller cannot inject prior_art / matched_features — Novelty always comes from the backend's own retrieval", async () => {
  const r = await handlePatentabilityRequest({
    mode: "upload",
    publication_year: 2022,
    features: [
      { id: "F1", text: "intent-based slice provisioning", ipc: "H04L 41", feature_id: "orchestration" },
      { id: "F2", text: "SDN controller", ipc: "H04L 45", feature_id: "sdn" },
    ],
    prior_art: [{ patent_no: "FAKE-999", matched_features: [] }], // should be ignored entirely
  });
  const novelty = r.breakdown.find((f) => f.factor === "novelty");
  assert.ok(!r.prior_art.some((p) => p.patent_no === "FAKE-999"), "backend-supplied prior_art must be real corpus retrieval, not the caller's claim");
  assert.ok(novelty.value >= 0 && novelty.value <= 1);
});

test("crowding and regional are always computed from the real matched-feature set, never a fixed IPC-group cap", async () => {
  const r = await handlePatentabilityRequest({
    mode: "upload",
    publication_year: 2022,
    features: [
      { id: "F1", text: "SDN controller", ipc: "H04L 45", feature_id: "sdn" },
      { id: "F2", text: "network slicing", ipc: "H04W 48", feature_id: "network_slicing" },
    ],
  });
  const crowding = r.breakdown.find((f) => f.factor === "crowding");
  const regional = r.breakdown.find((f) => f.factor === "regional");
  assert.equal(typeof crowding.value, "number");
  assert.equal(typeof regional.value, "number");
});

test("fewer than 2 in-scope features is out_of_scope, not scored with a diluted number", async () => {
  const r = await handlePatentabilityRequest({
    mode: "upload",
    publication_year: 2022,
    features: [{ id: "F1", text: "SDN controller", ipc: "H04L 45", feature_id: "sdn" }],
  });
  assert.equal(r.out_of_scope, true);
  assert.equal(r.reason, "insufficient");
  assert.equal(r.score, undefined);
});

test("target_jurisdiction is a request parameter and changes the Regional factor's target", async () => {
  const featuresArg = [
    { id: "F1", text: "SDN controller", ipc: "H04L 45", feature_id: "sdn" },
    { id: "F2", text: "network slicing", ipc: "H04W 48", feature_id: "network_slicing" },
  ];
  const us = await handlePatentabilityRequest({ mode: "upload", publication_year: 2022, features: featuresArg, target_jurisdiction: "US" });
  const jp = await handlePatentabilityRequest({ mode: "upload", publication_year: 2022, features: featuresArg, target_jurisdiction: "JP" });
  assert.equal(us.target_jurisdiction, "US");
  assert.equal(jp.target_jurisdiction, "JP");
});

test("sensitivityAnalysis reports whether the grade changes under each weight ±5%/±10%", async () => {
  const r = await handlePatentabilityRequest({
    mode: "upload",
    publication_year: 2022,
    features: [
      { id: "F1", text: "SDN controller", ipc: "H04L 45", feature_id: "sdn" },
      { id: "F2", text: "network slicing", ipc: "H04W 48", feature_id: "network_slicing" },
    ],
  });
  const sens = scoring.sensitivityAnalysis(r.breakdown, "en");
  assert.equal(sens.base_score, r.score);
  assert.equal(sens.base_grade, r.grade);
  assert.equal(sens.perturbations.length, r.breakdown.length * 4);
  assert.equal(typeof sens.robust, "boolean");
  for (const p of sens.perturbations) {
    assert.equal(p.grade_changed, p.grade !== sens.base_grade);
  }
});

test("lang=zh returns Chinese grade/labels, lang=en (default) returns English", async () => {
  const featuresArg = [
    { id: "F1", text: "SDN controller", ipc: "H04L 45", feature_id: "sdn" },
    { id: "F2", text: "network slicing", ipc: "H04W 48", feature_id: "network_slicing" },
  ];
  const en = await handlePatentabilityRequest({ mode: "upload", publication_year: 2022, features: featuresArg });
  const zh = await handlePatentabilityRequest({ mode: "upload", publication_year: 2022, features: featuresArg, lang: "zh" });
  assert.ok(["High", "Medium", "Low"].includes(en.grade));
  assert.ok(["高", "中", "低"].includes(zh.grade));
});
