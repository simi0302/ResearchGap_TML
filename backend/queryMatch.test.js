// Tests for the shared search-bar matcher and the AI query expansion verifier.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const Q = require("./queryMatch");
const { expandQuery, cleanQuery, parseModelTerms } = require("./queryExpansion");
const { loadRawCorpus } = require("./corpus");

const corpus = loadRawCorpus();
const hits = (q) => corpus.filter((p) => Q.scorePatent(Q.parseQuery(q), p, q) > 0).length;

test("the browser copy (../query-match.js) is byte-identical to backend/queryMatch.js", () => {
  const site = path.join(__dirname, "..", "query-match.js");
  if (!fs.existsSync(site)) return; // backend deployed on its own
  assert.equal(fs.readFileSync(site, "utf-8"), fs.readFileSync(path.join(__dirname, "queryMatch.js"), "utf-8"));
});

test("abbreviations match their spelled-out synonyms", () => {
  const literal = corpus.filter((p) => Q.literalMatch(p, "NFV")).length;
  assert.ok(hits("NFV") > literal, "synonyms should add results beyond the literal match");
});

test("Chinese and English names of the same concept return the same results", () => {
  assert.equal(hits("軟體定義網路"), hits("SDN"));
  assert.equal(hits("網路切片 5G"), hits("network slicing 5G"));
});

test("multi-word queries match each concept, not the exact phrase", () => {
  assert.ok(hits("network slicing 5G") > 0);
  assert.equal(corpus.filter((p) => Q.literalMatch(p, "network slicing 5G")).length, 0);
});

test("short terms need word boundaries; internal category labels are not searched", () => {
  const ai = Q.parseQuery("ai");
  assert.equal(ai[0].test(Q.normalize("We maintain the chain")), false);
  assert.equal(ai[0].test(Q.normalize("an AI-based controller")), true);
  assert.ok(hits("ai") < 50, "category ai_related_orchestration must not leak into matching");
});

test("quoted text is one literal concept", () => {
  const cs = Q.parseQuery('"network slice"');
  assert.equal(cs.length, 1);
  assert.equal(cs[0].fromDictionary, false);
});

test("nonsense returns nothing", () => {
  assert.equal(hits("xyzzyqq"), 0);
});

test("cleanQuery rejects empty, oversized and non-string input", () => {
  assert.equal(cleanQuery(""), null);
  assert.equal(cleanQuery("x".repeat(101)), null);
  assert.equal(cleanQuery({ a: 1 }), null);
  assert.equal(cleanQuery("  SDN \n controller "), "SDN controller");
});

test("parseModelTerms tolerates junk around the JSON and non-string entries", () => {
  assert.deepEqual(parseModelTerms('Sure: {"terms": ["a", 3, "b"]}'), ["a", "b"]);
  assert.deepEqual(parseModelTerms("not json"), []);
});

test("expandQuery keeps only model terms that exist in the corpus", async () => {
  const r = await expandQuery("SDN", {
    corpus,
    callModel: async () => JSON.stringify({
      terms: ["OpenFlow", "software defined networking", "zzqv frobnicator", "SDN", "openflow", "<script>"],
    }),
  });
  const terms = r.terms.map((t) => t.term);
  assert.ok(terms.includes("OpenFlow"));
  assert.ok(!terms.includes("software defined networking"), "already a synonym of the query");
  assert.ok(!terms.includes("SDN"), "the query itself");
  assert.equal(terms.filter((t) => t.toLowerCase() === "openflow").length, 1, "deduplicated");
  assert.ok(r.terms.every((t) => t.count > 0 && !/[<>]/.test(t.term)));
  assert.equal(r.rejected_not_in_corpus >= 1, true);
});

test("expandQuery keeps one term per concept (synonyms of each other return the same results)", async () => {
  const r = await expandQuery("NFV", {
    corpus,
    callModel: async () => JSON.stringify({
      terms: ["SDN", "Software Defined Networking", "VNF", "Virtual Network Functions", "Virtualized Network Functions", "network virtualization"],
    }),
  });
  const terms = r.terms.map((t) => t.term);
  assert.deepEqual(terms.filter((t) => /sdn|software defined/i.test(t)).length, 1);
  assert.deepEqual(terms.filter((t) => /vnf|virtual(ized)? network function/i.test(t)).length, 1);
  assert.ok(terms.includes("network virtualization"));
});

test("expandQuery rejects an invalid query without calling the model", async () => {
  let called = false;
  const r = await expandQuery("", { corpus, callModel: async () => { called = true; return "{}"; } });
  assert.equal(r.error, "invalid_query");
  assert.equal(called, false);
});
