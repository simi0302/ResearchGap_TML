// Persistent knowledge base — the "write back" half of retrieval-augmented generation.
//
// Before this module, everything fetched live (papers from Semantic Scholar / Crossref / arXiv,
// external patents verified on Google Patents) lived only in a 30-minute in-memory cache and was
// gone after a restart. Now every in-scope item is written back here, and every later search
// retrieves from here first, so the knowledge the system has seen keeps growing:
//
//   seed    data/knowledge_seed.jsonl.gz   built offline by scripts/crawl.js (AI-planned crawl,
//                                         backend-verified), shipped with the deploy
//   learned <KNOWLEDGE_DIR>/learned.jsonl  appended at runtime by live searches; on Azure App
//                                         Service KNOWLEDGE_DIR points under /home, which
//                                         survives restarts and redeploys
//
// The same "AI suggests, backend verifies" boundary as the rest of the backend applies: an item
// is stored only if its own title/abstract matches at least one feature of the fixed SDN/NFV
// taxonomy (features.js, same word-boundary matcher), it carries a real title and year, and a
// patent only ever arrives here after externalPriorArt.js fetched and parsed its real page.
// Nothing a model says is stored.
//
// Retrieval is Okapi BM25 over an inverted index (title + abstract), with an optional
// publication-date cutoff applied before ranking (基準日鐵律). The 2,799-patent GPSS corpus is
// NOT part of this store: Crowding / Regional / white-space statistics stay on that fixed,
// reproducible population.
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const features = require("./features");

const DATA_DIR = path.join(__dirname, "data");
const SEED_PATH = process.env.KNOWLEDGE_SEED_PATH || path.join(DATA_DIR, "knowledge_seed.jsonl.gz");

function defaultKnowledgeDir() {
  if (process.env.KNOWLEDGE_DIR) return process.env.KNOWLEDGE_DIR;
  // Azure App Service (Linux): /home is persistent storage; /home/site/wwwroot is wiped by
  // `az webapp deploy --clean true`, so learned data must live outside it.
  if (process.env.WEBSITE_SITE_NAME && fs.existsSync("/home")) return "/home/data/researchgap";
  return path.join(DATA_DIR, "learned");
}

const MAX_TITLE = 400;
const MAX_ABSTRACT = 2000;
const MAX_LEARNED_PER_DAY = Number(process.env.KNOWLEDGE_MAX_LEARNED_PER_DAY) || 5000;

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "of", "for", "in", "to", "with", "based", "method", "methods",
  "system", "systems", "device", "devices", "apparatus", "using", "via", "from", "on", "by", "its",
  "into", "at", "is", "are", "be", "such", "this", "that", "which", "not", "can", "may", "also",
  "each", "between", "over", "than", "then", "as", "it", "their", "these", "we", "our", "paper",
  "propose", "proposed", "approach", "results", "show", "new", "network", "networks", "networking",
]);

function tokenize(text) {
  return (String(text || "").toLowerCase().match(/[a-z0-9][a-z0-9-]{1,}/g) || []).filter((t) => !STOPWORDS.has(t) && !/^\d+$/.test(t));
}

function normTitle(t) {
  return String(t || "").toLowerCase().replace(/<[^>]+>/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
}

function stripMarkup(s) {
  return String(s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function patentBase(n) {
  return String(n || "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/[A-Z]\d?$/, "");
}

// Stable identity so the same paper arriving from Crossref, then Semantic Scholar, then the
// crawler is stored once: DOI when there is one, patent base number for patents, else title.
function idFor(item) {
  if (item.type === "patent") return `patent:${patentBase(item.publication_number || item.number)}`;
  const doi = String(item.doi || "").toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, "").trim();
  if (doi) return `doi:${doi}`;
  const arxiv = String(item.url || "").match(/arxiv\.org\/abs\/([0-9.]+)/i);
  if (arxiv) return `arxiv:${arxiv[1]}`;
  return `title:${normTitle(item.title).slice(0, 160)}`;
}

const CORE_FEATURES = new Set(["sdn", "nfv", "sfc", "network_slicing", "oran", "openflow", "5g_core"]);
function inScope(featureIds) {
  return featureIds.some((f) => CORE_FEATURES.has(f)) || featureIds.length >= 2;
}

// Validates and normalizes one candidate. Returns null when it should not be stored.
function normalize(raw, origin) {
  if (!raw || typeof raw !== "object") return null;
  const type = raw.type === "patent" ? "patent" : "paper";
  const title = stripMarkup(raw.title).slice(0, MAX_TITLE);
  if (title.length < 8) return null;
  if (/^(fig(ure)?|table|supplementary)[\s.]*\w*\s*[:.]/i.test(title)) return null; // Crossref figure DOIs
  const abstract = stripMarkup(raw.abstract).slice(0, MAX_ABSTRACT);
  const date = /^\d{4}-\d{2}-\d{2}$/.test(raw.date || raw.publication_date || "") ? raw.date || raw.publication_date : null;
  const year = Number(raw.year || (date ? date.slice(0, 4) : NaN));
  // A year after the current one is a publisher's forthcoming-issue date, not a publication
  // that exists yet — it would also slip past any cutoff filter, so it is not stored.
  if (!Number.isInteger(year) || year < 1950 || year > new Date().getFullYear()) return null;
  const url = /^https?:\/\//.test(raw.url || "") ? String(raw.url).slice(0, 500) : null;
  // Domain gate: the item's own text must contain one core SDN/NFV/slicing feature, or at
  // least two taxonomy features (a lone "latency" or "container" is not enough).
  const feats = [...features.matchFeaturesInText(`${title} ${abstract}`).keys()];
  if (!inScope(feats)) return null;
  const item = {
    type,
    title,
    abstract,
    year,
    date: date || null,
    venue: raw.venue ? stripMarkup(raw.venue).slice(0, 200) : null,
    url,
    doi: raw.doi ? String(raw.doi).toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, "").slice(0, 200) : null,
    source: String(raw.source || "unknown").slice(0, 40),
    authors: Array.isArray(raw.authors) ? raw.authors.slice(0, 8).map((a) => String(a).slice(0, 80)) : undefined,
    cited_by: Number.isFinite(raw.cited_by) ? raw.cited_by : undefined,
    publication_number: type === "patent" ? String(raw.publication_number || "").slice(0, 30) : undefined,
    jurisdiction: type === "patent" ? String(raw.jurisdiction || "").slice(0, 4) : undefined,
    features: feats,
    origin,
    query: raw.query ? String(raw.query).slice(0, 120) : undefined,
    added_at: raw.added_at || new Date().toISOString(),
  };
  item.id = idFor(item);
  return item;
}

// ---------------------------------------------------------------------------------------
class KnowledgeStore {
  constructor({ seedPath = SEED_PATH, dir = defaultKnowledgeDir(), persist = true } = {}) {
    this.seedPath = seedPath;
    this.dir = dir;
    this.learnedPath = dir ? path.join(dir, "learned.jsonl") : null;
    this.persist = persist && Boolean(dir);
    this.docs = []; // [{item, len}]
    this.byId = new Map(); // id -> index
    this.postings = new Map(); // token -> [[docIndex, tf], ...]
    this.totalLen = 0;
    this.learnedToday = { day: null, n: 0 };
    this.loaded = false;
    this.writeChain = Promise.resolve();
  }

  load() {
    if (this.loaded) return this;
    this.loaded = true;
    this.seedCount = 0;
    this.learnedCount = 0;
    if (this.seedPath && fs.existsSync(this.seedPath)) {
      const buf = fs.readFileSync(this.seedPath);
      const text = this.seedPath.endsWith(".gz") ? zlib.gunzipSync(buf).toString("utf-8") : buf.toString("utf-8");
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          if (this._index(JSON.parse(line))) this.seedCount++;
        } catch {
          // skip a corrupt line rather than refusing to start
        }
      }
    }
    if (this.learnedPath && fs.existsSync(this.learnedPath)) {
      for (const line of fs.readFileSync(this.learnedPath, "utf-8").split("\n")) {
        if (!line.trim()) continue;
        try {
          if (this._index(JSON.parse(line))) this.learnedCount++;
        } catch {
          // a half-written last line after a crash is expected; skip it
        }
      }
    }
    return this;
  }

  _index(item) {
    if (!item || !item.id || this.byId.has(item.id)) return false;
    const idx = this.docs.length;
    const tokens = tokenize(`${item.title} ${item.title} ${item.abstract || ""}`); // title counted twice
    const tf = new Map();
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1);
    for (const [t, f] of tf) {
      let list = this.postings.get(t);
      if (!list) this.postings.set(t, (list = []));
      list.push([idx, f]);
    }
    this.docs.push({ item, len: tokens.length });
    this.byId.set(item.id, idx);
    this.totalLen += tokens.length;
    return true;
  }

  has(id) {
    this.load();
    return this.byId.has(id);
  }

  // Write-back. Returns { added, skipped_duplicate, rejected } so callers (and the UI) can
  // report exactly what the knowledge base learned from this search.
  addMany(rawItems, { origin = "live-search", query } = {}) {
    this.load();
    const out = { added: 0, skipped_duplicate: 0, rejected: 0, added_items: [] };
    const fresh = [];
    const today = new Date().toISOString().slice(0, 10);
    if (this.learnedToday.day !== today) this.learnedToday = { day: today, n: 0 };
    for (const raw of rawItems || []) {
      const item = normalize({ ...raw, query: raw?.query || query }, origin);
      if (!item) {
        out.rejected++;
        continue;
      }
      if (this.byId.has(item.id)) {
        out.skipped_duplicate++;
        continue;
      }
      if (origin !== "seed" && this.learnedToday.n >= MAX_LEARNED_PER_DAY) {
        out.rejected++;
        continue;
      }
      this._index(item);
      if (origin !== "seed") {
        this.learnedToday.n++;
        this.learnedCount++;
      }
      out.added++;
      out.added_items.push(item.id);
      fresh.push(item);
    }
    if (fresh.length && this.persist && origin !== "seed") this._append(fresh);
    return out;
  }

  _append(items) {
    const lines = items.map((i) => JSON.stringify(i)).join("\n") + "\n";
    this.writeChain = this.writeChain
      .then(() => fs.promises.mkdir(this.dir, { recursive: true }))
      .then(() => fs.promises.appendFile(this.learnedPath, lines, "utf-8"))
      .catch((err) => console.error("knowledgeStore: write-back failed", err.message));
  }

  flush() {
    return this.writeChain;
  }

  // BM25 search. opts: { type: "paper"|"patent", cutoffDate: "YYYY-MM-DD", limit, minYear }
  search(query, { type, cutoffDate, limit = 10, minYear } = {}) {
    this.load();
    const qTokens = [...new Set(tokenize(query))];
    const N = this.docs.length;
    if (!N || !qTokens.length) return [];
    const cutoffYear = cutoffDate ? Number(cutoffDate.slice(0, 4)) : null;
    const allowed = (d) => {
      const it = d.item;
      if (type && it.type !== type) return false;
      if (minYear && it.year < minYear) return false;
      if (cutoffDate) {
        if (it.date) return it.date <= cutoffDate;
        return it.year <= cutoffYear;
      }
      return true;
    };
    const avgdl = this.totalLen / N;
    const k1 = 1.5;
    const b = 0.75;
    const scores = new Map();
    const hits = new Map();
    for (const t of qTokens) {
      const list = this.postings.get(t);
      if (!list) continue;
      const idf = Math.log(1 + (N - list.length + 0.5) / (list.length + 0.5));
      for (const [idx, f] of list) {
        const d = this.docs[idx];
        const s = idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / avgdl)));
        scores.set(idx, (scores.get(idx) || 0) + s);
        hits.set(idx, (hits.get(idx) || 0) + 1);
      }
    }
    // Coverage bonus: a document matching more distinct query terms ranks above one that
    // repeats a single term many times.
    const ranked = [];
    for (const [idx, s] of scores) {
      const d = this.docs[idx];
      if (!allowed(d)) continue;
      ranked.push({ idx, score: s * (1 + hits.get(idx) / qTokens.length) });
    }
    ranked.sort((x, y) => y.score - x.score);
    const top = ranked.slice(0, limit);
    const max = top.length ? top[0].score : 0;
    return top.map(({ idx, score }) => ({ ...this.docs[idx].item, relevance: max ? Math.round((score / max) * 1000) / 1000 : 0 }));
  }

  stats() {
    this.load();
    const byType = { paper: 0, patent: 0 };
    const byOrigin = {};
    const bySource = {};
    const byYear = {};
    let latest = null;
    for (const { item } of this.docs) {
      byType[item.type] = (byType[item.type] || 0) + 1;
      byOrigin[item.origin] = (byOrigin[item.origin] || 0) + 1;
      bySource[item.source] = (bySource[item.source] || 0) + 1;
      byYear[item.year] = (byYear[item.year] || 0) + 1;
      if (item.origin !== "seed" && (!latest || item.added_at > latest)) latest = item.added_at;
    }
    return {
      total: this.docs.length,
      by_type: byType,
      by_origin: byOrigin,
      by_source: bySource,
      by_year: byYear,
      seed: this.seedCount || 0,
      learned: this.learnedCount || 0,
      last_learned_at: latest,
      vocabulary: this.postings.size,
      persistent: this.persist,
    };
  }

  recentLearned(limit = 10) {
    this.load();
    const out = [];
    for (let i = this.docs.length - 1; i >= 0 && out.length < limit; i--) {
      const it = this.docs[i].item;
      if (it.origin !== "seed") out.push({ id: it.id, type: it.type, title: it.title, year: it.year, source: it.source, origin: it.origin, query: it.query, added_at: it.added_at, url: it.url });
    }
    return out;
  }
}

// Process-wide singleton (server + tools + patentability share one index).
let _store = null;
function getStore() {
  // Under `node --test` the shared store starts empty and never writes, so the scoring tests
  // stay hermetic no matter what this machine has learned; knowledgeStore.test.js builds its own.
  if (!_store) _store = process.env.NODE_TEST_CONTEXT ? new KnowledgeStore({ seedPath: null, dir: null, persist: false }) : new KnowledgeStore();
  return _store;
}
// Test seam.
function _setStore(s) {
  _store = s;
}

module.exports = { KnowledgeStore, getStore, _setStore, normalize, idFor, tokenize, patentBase, inScope };
