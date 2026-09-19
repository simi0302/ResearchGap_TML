// External prior art counts toward Novelty, but only through backend-fetched, backend-parsed
// data (externalPriorArt.js). Network is stubbed via _setNetwork — no real requests here.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { handlePatentabilityRequest } = require("./patentability");
const external = require("./externalPriorArt");
const corpus = require("./corpus");

const TEXT = fs.readFileSync(path.join(__dirname, "fixtures", "oran-federated-ric.txt"), "utf-8");

function pageHtml({ title, abstract, issue }) {
  return `<html><head><meta name="DC.title" content="${title}">` +
    `<meta name="DC.date" content="2015-01-01" scheme="dateSubmitted">` +
    (issue ? `<meta name="DC.date" content="${issue}" scheme="issue">` : "") +
    `</head><body><abstract lang="EN"><div>${abstract}</div></abstract></body></html>`;
}

// An external "patent" whose abstract is the case document itself → maximal feature overlap.
const OVERLAP = { title: "Federated RIC orchestration", abstract: TEXT.slice(0, 1800), issue: "2019-06-04" };

function stub(pages, numbers = Object.keys(pages)) {
  external._setNetwork({
    candidates: async () => ({ numbers, note: null }),
    page: async (n) => (pages[n] ? pageHtml(pages[n]) : null),
  });
}

test.afterEach(() => external._setNetwork());

async function run() {
  return handlePatentabilityRequest({ mode: "upload", text: TEXT });
}
const novelty = (r) => r.breakdown.find((b) => b.factor === "novelty");

test("a backend-verified external patent enters prior_art and lowers Novelty", async () => {
  stub({});
  const base = await run();
  stub({ US99000001B2: OVERLAP });
  const r = await run();
  const ext = r.prior_art.find((p) => p.source === "external");
  assert.ok(ext, "external patent should be retrieved as prior art");
  assert.equal(ext.patent_no, "US99000001B2");
  assert.ok(ext.matched_features.length > 0, "overlap is computed by the backend from the fetched text");
  assert.ok(novelty(r).value < novelty(base).value, "closer prior art must lower Novelty");
  assert.deepEqual(r.external_prior_art.used, ["US99000001B2"]);
});

test("external patents do not change Crowding, Temporal or Regional (fixed corpus only)", async () => {
  stub({});
  const base = await run();
  stub({ US99000001B2: OVERLAP });
  const r = await run();
  for (const f of ["crowding", "regional"]) {
    assert.equal(r.breakdown.find((b) => b.factor === f).value, base.breakdown.find((b) => b.factor === f).value);
  }
  assert.deepEqual(r.combination_whitespace, base.combination_whitespace);
});

test("an external patent published after the cutoff is excluded", async () => {
  stub({ US99000002B2: { ...OVERLAP, issue: "2031-01-01" } });
  const r = await run();
  assert.equal(r.external_prior_art.count, 0);
  assert.ok(!r.prior_art.some((p) => p.source === "external"));
});

test("a patent already in the corpus is not double-counted", async () => {
  const inCorpus = corpus.loadRawCorpus()[0].publication_number;
  stub({ [inCorpus]: OVERLAP });
  const r = await run();
  assert.equal(r.external_prior_art.count, 0);
});

test("unreachable / hallucinated patent numbers are dropped", async () => {
  stub({}, ["US11111111B2"]);
  const r = await run();
  assert.equal(r.external_prior_art.count, 0);
});

test("if external lookup throws, scoring falls back to the corpus alone", async () => {
  stub({});
  const base = await run();
  external._setNetwork({ candidates: async () => { throw new Error("boom"); } });
  const r = await run();
  assert.equal(r.score, base.score);
  assert.equal(r.external_prior_art.count, 0);
  assert.match(r.external_prior_art.note, /failed/);
});

test("buildQueries yields up to 3 distinct, narrower feature-pair queries", () => {
  const f = (t) => ({ text: t });
  assert.deepEqual(external.buildQueries([]), []);
  assert.deepEqual(external.buildQueries([f("A")]), ["A"]);
  const q = external.buildQueries([f("A"), f("B"), f("C"), f("D"), f("E")]);
  assert.equal(q.length, 3);
  assert.equal(new Set(q).size, 3);
  assert.ok(q.every((s) => s.split(" ").length <= 2));
});

test("a caller-supplied external_patents / prior_art field is ignored", async () => {
  stub({});
  const r = await handlePatentabilityRequest({
    mode: "upload",
    text: TEXT,
    external_patents: [{ publication_number: "FAKE-1", title: "x", abstract: TEXT, publication_date: "2019-01-01", source: "external" }],
    prior_art: [{ patent_no: "FAKE-2", matched_features: [] }],
  });
  assert.ok(!r.prior_art.some((p) => /FAKE/.test(p.patent_no)));
});
