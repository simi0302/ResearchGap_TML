// Field-wide white-space scan: counts are patents classified under both groups (corpus IPC +
// knowledge-base CPC), expected / lift follow from the side sizes, artefact pairs are flagged,
// and the OpenAlex query keeps the patent matcher's "every concept must appear" rule.
const test = require("node:test");
const assert = require("node:assert/strict");
const knowledgeStore = require("./knowledgeStore");
const whiteSpace = require("./whiteSpace");
const { openAlexQuery } = require("./landscape");
const QueryMatch = require("./queryMatch");

const kb = new knowledgeStore.KnowledgeStore({ seedPath: null, dir: null, persist: false });
kb.addMany(
  [
    { type: "patent", publication_number: "US99999991B2", jurisdiction: "US", title: "Network slice selection with virtual machine scheduling", abstract: "Selecting a network slice for a user equipment while scheduling virtualized network functions.", date: "2024-02-06", source: "GPSS" },
  ],
  { origin: "gpss" }
);
for (const d of kb.docs) {
  d.item.cpc = ["H04W48/18", "G06F9/45558"];
  d.item.assignee = "Example Networks Inc.";
}
knowledgeStore._setStore(kb);
whiteSpace._clearCache();

test("scan: 12 groups, pairs with both sides large, sorted by lift, artefacts last", () => {
  const s = whiteSpace.scanWhiteSpace({ limit: 66, minSide: 0 });
  assert.equal(s.groups.length, 12);
  assert.equal(s.candidates.length, 66);
  const clean = s.candidates.filter((c) => !c.caveat);
  for (let i = 1; i < clean.length; i++) assert.ok(clean[i - 1].lift <= clean[i].lift);
  const firstArtefact = s.candidates.findIndex((c) => c.caveat);
  if (firstArtefact >= 0) assert.ok(s.candidates.slice(firstArtefact).every((c) => c.caveat));
  for (const c of s.candidates) {
    assert.equal(c.patents, c.corpus + c.knowledge_base);
    assert.ok(c.patents <= Math.min(c.side_a_patents, c.side_b_patents));
  }
  assert.match(s.population, /corpus patents .* knowledge-base patents/);
});

test("a knowledge-base patent counts toward its CPC main groups", () => {
  const pair = whiteSpace.scanWhiteSpace({ limit: 66, minSide: 0 }).candidates.find((c) => [c.a, c.b].sort().join("|") === ["G06F 9", "H04W 48"].sort().join("|"));
  assert.ok(pair, "H04W 48 and G06F 9 are among the 12 groups");
  assert.ok(pair.knowledge_base >= 1);
  const d = whiteSpace.cellDetail(pair.a, pair.b);
  assert.ok(d.combined_patents.some((p) => p.publication_number === "US99999991B2" && p.source === "knowledge_base"));
  assert.ok(d.top_applicants_side_a.length > 0 && d.top_applicants_side_b.length > 0);
});

test("cell detail rejects unknown or identical groups", () => {
  assert.ok(whiteSpace.cellDetail("H04W 48", "H04W 48").error);
  assert.ok(whiteSpace.cellDetail("A01B 1", "H04W 48").error);
});

test("applicant spellings from the corpus and GPSS are grouped", () => {
  const k = whiteSpace.applicantKey;
  assert.equal(k("Huawei Technologies Co."), k("HUAWEI TECHNOLOGIES CO LTD"));
  assert.equal(k("Intel Corp."), k("Intel Corporation"));
  assert.equal(k("Telefonaktiebolaget LM Ericsson (publ)"), "telefonaktiebolaget lm ericsson");
  assert.notEqual(k("Cisco Technology"), k("Intel Corp."));
});

test("OpenAlex query: variants OR-ed, concepts AND-ed, Chinese variants dropped", () => {
  assert.equal(openAlexQuery(QueryMatch.parseQuery("網路切片 數位孿生")), '("network slicing" OR "network slice") AND "digital twin"');
  assert.equal(openAlexQuery(QueryMatch.parseQuery("network slicing")), '("network slicing" OR "network slice")');
});
