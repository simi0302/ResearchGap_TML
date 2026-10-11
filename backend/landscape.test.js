// Topic landscape and the search bar's knowledge-base patent search: knowledge-base patents are
// reported as their own population (never mixed into the corpus counts or the paper counts),
// matched with the same concept matcher, and filtered by year / jurisdiction / cutoff.
const test = require("node:test");
const assert = require("node:assert/strict");
const knowledgeStore = require("./knowledgeStore");
const { topicLandscape, searchKbPatents } = require("./landscape");

const kb = new knowledgeStore.KnowledgeStore({ seedPath: null, dir: null, persist: false });
kb.addMany(
  [
    { type: "patent", publication_number: "CN112153700B", jurisdiction: "CN", title: "Network slice resource management method and equipment", abstract: "Allocating resources to a network slice instance in a 5G core.", date: "2022-03-29", source: "Google Patents" },
    { type: "patent", publication_number: "KR102894411B1", jurisdiction: "KR", title: "Apparatus and method for generating network slice in a wireless communication system", abstract: "Network slicing for 5G user equipment.", date: "2025-12-01", source: "Google Patents" },
    { type: "patent", publication_number: "US11895501B2", jurisdiction: "US", title: "Software-defined networking controller for service function chaining", abstract: "An SDN controller steers traffic through a service function chain.", date: "2024-02-06", source: "Google Patents" },
  ],
  { origin: "citation-crawl" }
);
kb.addMany([{ title: "Digital twin assisted network slicing for 5G", abstract: "We propose a digital twin that predicts network slice demand.", year: 2021, doi: "10.1000/x", source: "Crossref" }]);
for (const d of kb.docs) if (d.item.publication_number === "CN112153700B") d.item.assignee = "Huawei Technologies Co Ltd";
knowledgeStore._setStore(kb);

test("landscape reports knowledge-base patents separately from corpus patents and papers", () => {
  const r = topicLandscape("network slicing");
  assert.equal(r.patents_kb.matched, 2);
  assert.equal(r.papers.matched, 1, "patents are not counted as papers");
  assert.match(r.patents_kb.population, /N=3/);
  assert.deepEqual(Object.keys(r.patents_kb.by_jurisdiction).sort(), ["CN", "KR"]);
  assert.equal(r.patents_kb.top_applicants[0].name, "Huawei Technologies Co Ltd");
  assert.ok(r.patents.population.startsWith("GPSS corpus"), "corpus figures unchanged");
});

test("results are cached per argument set (same object back within the TTL)", () => {
  assert.equal(topicLandscape("network slicing"), topicLandscape("network slicing"));
  assert.notEqual(searchKbPatents("network slicing", { limit: 1 }), searchKbPatents("network slicing", { limit: 2 }));
});

test("landscape cutoff year applies to knowledge-base patents", () => {
  assert.equal(topicLandscape("network slicing", { cutoffYear: 2023 }).patents_kb.matched, 1);
});

test("search bar KB patents: synonyms, filters, paging", () => {
  const all = searchKbPatents("network slicing");
  assert.equal(all.total, 2);
  assert.equal(all.population, 3);
  assert.equal(searchKbPatents("網路切片").total, 2, "Chinese query maps to the same concept");
  assert.equal(searchKbPatents("network slicing", { country: "KR" }).total, 1);
  assert.equal(searchKbPatents("network slicing", { from: 2023 }).results[0].publication_number, "KR102894411B1");
  assert.equal(searchKbPatents("network slicing", { limit: 1 }).results.length, 1);
  assert.equal(searchKbPatents("SDN").total, 1);
  assert.ok(searchKbPatents("").error);
});
