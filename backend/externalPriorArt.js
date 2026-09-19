// External prior art that COUNTS toward the Novelty score — backend-controlled, never
// model-controlled. The model's web search (webSearch.js) is used only as a *candidate
// finder*: it may suggest patent numbers/URLs, but nothing it says about a patent (its
// date, its abstract, what it "overlaps") is trusted. For every candidate this module
// fetches the real Google Patents page itself, parses title / publication date / abstract /
// jurisdiction from the page, drops anything not published on/before the cutoff or already in
// the internal corpus, and hands the survivors to retrieval.js, where the same deterministic
// BM25 + word-boundary feature matching used for the 2,799-patent corpus runs over them.
// A hallucinated patent number simply 404s and is dropped.
//
// Scope: external patents feed Novelty (prior-art overlap) ONLY. Crowding / Regional /
// combination white-space are statistics over the fixed corpus and stay reproducible.
// Any failure (no Azure config, timeout, layout change) yields [] plus a note — the score
// then falls back to the corpus alone, exactly as before.
const webSearch = require("./webSearch");
const corpus = require("./corpus");

const MAX_CANDIDATES = 8;
const FETCH_TIMEOUT_MS = 8000;
const PATENT_URL_RE = /patents\.google\.com\/patent\/([A-Z]{2}[0-9A-Z]{4,}[A-Z0-9]*)/gi;
const PATENT_NO_RE = /\b(US|EP|JP|TW|WO|CN|KR)[- ]?(\d{5,}[A-Z]?\d?)\b/g;

// Per-process cache keyed by query+cutoff so repeated scoring of the same case is stable and
// doesn't re-hit the network within a session.
const cache = new Map();

// Test seam: replace the two network steps without touching real services.
let findCandidates = defaultFindCandidates;
let fetchPage = defaultFetchPage;
function _setNetwork({ candidates, page } = {}) {
  findCandidates = candidates || defaultFindCandidates;
  fetchPage = page || defaultFetchPage;
  cache.clear();
}

function normalizeNumber(n) {
  return String(n || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

// Strip the kind code so "US9686201B2" and a corpus "US9686201" compare equal.
function baseNumber(n) {
  return normalizeNumber(n).replace(/[A-Z]\d?$/, "");
}

async function defaultFindCandidates(query, cutoffDate) {
  const r = await webSearch.searchWeb(`patents: ${query}`, { cutoffDate });
  const found = new Set();
  const scan = (text) => {
    for (const m of String(text || "").matchAll(PATENT_URL_RE)) found.add(normalizeNumber(m[1]));
  };
  for (const item of r.results || []) scan(item.url);
  scan(r.summary);
  for (const m of String(r.summary || "").matchAll(PATENT_NO_RE)) found.add(normalizeNumber(m[1] + m[2]));
  return { numbers: [...found].slice(0, MAX_CANDIDATES), note: r.note };
}

async function defaultFetchPage(number) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`https://patents.google.com/patent/${number}/en`, {
      headers: { "User-Agent": "Mozilla/5.0 ResearchGap-TML" },
      signal: ctrl.signal,
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

function stripTags(s) {
  return String(s || "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
}

// Parse the fields the score needs from a Google Patents page. Returns null unless a real
// title, abstract and publication date are all present.
function parsePatentPage(html, number) {
  if (!html) return null;
  const title = stripTags((html.match(/<meta name="DC\.title" content="([^"]*)"/) || [])[1]);
  const abstractMatch = html.match(/<abstract[^>]*>([\s\S]*?)<\/abstract>/);
  const metaDesc = (html.match(/<meta name="(?:DC\.)?description" content="([^"]*)"/) || [])[1];
  const abstract = stripTags(abstractMatch ? abstractMatch[1] : "") || stripTags(metaDesc);
  // The page's own publication date (this document's, e.g. the A1 date for an application);
  // fall back to the grant date, then the undated DC.date meta. Never the filing date.
  const pub = (html.match(/itemprop="publicationDate"[^>]*datetime="(\d{4}-\d{2}-\d{2})"/) || [])[1]
    || (html.match(/datetime="(\d{4}-\d{2}-\d{2})"[^>]*itemprop="publicationDate"/) || [])[1]
    || (html.match(/<meta name="DC\.date" content="(\d{4}-\d{2}-\d{2})" scheme="issue"/) || [])[1];
  if (!title || !abstract || !pub) return null;
  return {
    publication_number: number,
    title,
    abstract,
    publication_date: pub,
    jurisdiction: number.slice(0, 2),
    ipc: [],
    source: "external",
  };
}

// caseFeatures: features.js output. Returns { patents, note }.
async function fetchExternalPatents(caseFeatures, cutoffDate) {
  const query = caseFeatures.slice(0, 4).map((f) => f.text).join(" ").trim();
  if (!query) return { patents: [], note: null };
  const key = `${query}|${cutoffDate}`;
  if (cache.has(key)) return cache.get(key);

  let out;
  try {
    const { numbers, note } = await findCandidates(query, cutoffDate);
    const known = new Set(corpus.loadRawCorpus().map((p) => baseNumber(p.publication_number)));
    const seen = new Set();
    const patents = [];
    const pages = await Promise.all(numbers.map(async (n) => ({ n, html: await fetchPage(n) })));
    for (const { n, html } of pages) {
      const b = baseNumber(n);
      if (known.has(b) || seen.has(b)) continue; // already in the corpus / duplicate candidate
      seen.add(b);
      const p = parsePatentPage(html, n);
      if (!p) continue; // unreachable page or hallucinated number
      if (cutoffDate && p.publication_date > cutoffDate) continue; // 基準日鐵律
      patents.push(p);
    }
    out = { patents, note: patents.length ? null : note || "No additional external patents were found." };
  } catch (err) {
    out = { patents: [], note: `External patent lookup failed: ${err.message}` };
  }
  cache.set(key, out);
  return out;
}

module.exports = { fetchExternalPatents, parsePatentPage, baseNumber, _setNetwork };
