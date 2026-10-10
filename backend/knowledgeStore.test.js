// Knowledge base (RAG write-back): what gets stored, de-duplication, cutoff-aware retrieval,
// and persistence across a restart. Each test uses its own temp directory.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { KnowledgeStore } = require("./knowledgeStore");

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "rg-kb-"));
}

const SLICING = {
  title: "Digital twin assisted network slicing for 5G",
  abstract: "We propose a digital twin that predicts network slice demand and reconfigures slices.",
  year: 2021,
  doi: "10.1000/slicing.1",
  source: "Crossref",
};
const SDN = {
  title: "OpenFlow controller placement in software-defined networking",
  abstract: "Controller placement for SDN control plane latency.",
  year: 2015,
  url: "https://arxiv.org/abs/1501.00001",
  source: "arXiv",
};

test("only in-scope records with a real title and year are stored", () => {
  const kb = new KnowledgeStore({ seedPath: null, dir: null, persist: false });
  const r = kb.addMany([
    SLICING,
    { title: "Crop yield prediction with satellite imagery", abstract: "Agriculture and remote sensing.", year: 2020 },
    { title: "Latency of a web server", abstract: "We measure latency.", year: 2020 }, // one generic feature only
    { title: "Figure 3: SDN controller architecture", year: 2019 },
    { title: "Network slicing without a year" },
  ]);
  assert.equal(r.added, 1);
  assert.equal(r.rejected, 4);
});

test("the same work from two sources is stored once (DOI, arXiv id, then title)", () => {
  const kb = new KnowledgeStore({ seedPath: null, dir: null, persist: false });
  kb.addMany([SLICING, SDN]);
  const again = kb.addMany([
    { ...SLICING, source: "Semantic Scholar", doi: "https://doi.org/10.1000/SLICING.1" },
    { ...SDN, title: "OpenFlow controller placement in software-defined networking (v2)" },
  ]);
  assert.equal(again.added, 0);
  assert.equal(again.skipped_duplicate, 2);
  assert.equal(kb.stats().total, 2);
});

test("retrieval ranks the relevant record first and honours the cutoff date", () => {
  const kb = new KnowledgeStore({ seedPath: null, dir: null, persist: false });
  kb.addMany([SLICING, SDN]);
  assert.equal(kb.search("network slicing digital twin")[0].title, SLICING.title);
  assert.equal(kb.search("network slicing digital twin", { cutoffDate: "2019-12-31" }).some((x) => x.title === SLICING.title), false);
  assert.equal(kb.search("openflow controller", { type: "patent" }).length, 0);
});

test("learned records persist across a restart; seed records are loaded but never rewritten", async () => {
  const dir = tmpDir();
  const seedPath = path.join(dir, "seed.jsonl.gz");
  const seedKb = new KnowledgeStore({ seedPath: null, dir: null, persist: false });
  seedKb.addMany([SDN], { origin: "seed" });
  fs.writeFileSync(seedPath, zlib.gzipSync(seedKb.docs.map((d) => JSON.stringify(d.item)).join("\n")));

  const kb = new KnowledgeStore({ seedPath, dir });
  kb.addMany([SLICING], { origin: "live-search", query: "slicing" });
  await kb.flush();
  const lines = fs.readFileSync(path.join(dir, "learned.jsonl"), "utf-8").trim().split("\n");
  assert.equal(lines.length, 1, "only the learned record is appended");

  const restarted = new KnowledgeStore({ seedPath, dir });
  const s = restarted.stats();
  assert.equal(s.total, 2);
  assert.equal(s.seed, 1);
  assert.equal(s.learned, 1);
  assert.equal(restarted.recentLearned(5)[0].query, "slicing");
});

test("a corrupt line in the learned file is skipped, not fatal", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "learned.jsonl"), '{"broken":\n');
  const kb = new KnowledgeStore({ seedPath: null, dir });
  assert.equal(kb.stats().total, 0);
});
