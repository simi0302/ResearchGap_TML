// External literature search — three free/keyless sources (Semantic Scholar, Crossref,
// arXiv) for the search_prior_art tool's citation list, plus OpenAlex's group_by=
// publication_year for the Temporal factor's real per-year publication counts (P0-1 fix
// item 5 — replaces comparing ~15 relevance-ranked search hits against a whole IPC group's
// patent count, which is not a real year-over-year trend). Every query applies the cutoff
// date AT THE SOURCE (P0-5) — a result published after the cutoff should never even be
// fetched, not filtered out afterward. Results are cached per (source, query, cutoff) with a
// TTL so the same document + same settings reproduces the same score (P1 item 8).
const CACHE_TTL_MS = 30 * 60 * 1000;
const _cache = new Map();

function cacheKey(parts) {
  return parts.join("|");
}
function getCached(key) {
  const hit = _cache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;
  return null;
}
function setCached(key, value) {
  _cache.set(key, { expires: Date.now() + CACHE_TTL_MS, value });
  return value;
}

async function searchSemanticScholar(query, { limit = 5, cutoffYear } = {}) {
  const key = cacheKey(["ss", query, limit, cutoffYear]);
  const cached = getCached(key);
  if (cached) return cached;
  const yearParam = cutoffYear ? `&year=-${cutoffYear}` : "";
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${limit}&fields=title,year,venue,url,abstract${yearParam}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Semantic Scholar ${res.status}`);
  const data = await res.json();
  const results = (data.data || []).map((p) => ({
    title: p.title,
    year: p.year ?? null,
    venue: p.venue || null,
    url: p.url || (p.paperId ? `https://www.semanticscholar.org/paper/${p.paperId}` : null),
    source: "Semantic Scholar",
    tier: "L2",
  }));
  return setCached(key, results);
}

// Crossref: free, keyless — indexes DOI-bearing works across journals/conferences
// (including most IEEE Xplore/ACM Digital Library papers), so this is real L2 coverage
// beyond Semantic Scholar with no key configured. `until-pub-date` applies the cutoff at
// the source instead of the caller filtering results afterward.
async function searchCrossref(query, { limit = 5, cutoffDate } = {}) {
  const key = cacheKey(["crossref", query, limit, cutoffDate]);
  const cached = getCached(key);
  if (cached) return cached;
  const filterParam = cutoffDate ? `&filter=until-pub-date:${cutoffDate}` : "";
  const url = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${limit}${filterParam}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Crossref ${res.status}`);
  const data = await res.json();
  const results = (data.message?.items || [])
    .map((p) => ({
      title: Array.isArray(p.title) ? p.title[0] : p.title || null,
      year: p.issued?.["date-parts"]?.[0]?.[0] ?? null,
      venue: p["container-title"]?.[0] || null,
      url: p.URL || (p.DOI ? `https://doi.org/${p.DOI}` : null),
      source: "Crossref",
      tier: "L2",
    }))
    .filter((p) => p.title);
  return setCached(key, results);
}

// arXiv: free, keyless — real preprints (L3, "not peer reviewed"). submittedDate applies
// the cutoff at the source (arXiv's own query syntax), not a post-hoc filter.
async function searchArxiv(query, { limit = 5, cutoffDate } = {}) {
  const key = cacheKey(["arxiv", query, limit, cutoffDate]);
  const cached = getCached(key);
  if (cached) return cached;
  const upper = cutoffDate ? cutoffDate.replace(/-/g, "") : "20301231";
  const dateFilter = `+AND+submittedDate:[19000101+TO+${upper}]`;
  const url = `http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}${dateFilter}&start=0&max_results=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`arXiv ${res.status}`);
  const xml = await res.text();
  const entries = xml.split("<entry>").slice(1);
  const results = entries
    .map((e) => {
      const title = e.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.replace(/\s+/g, " ").trim() || null;
      const published = e.match(/<published>(\d{4})-/)?.[1];
      const id = e.match(/<id>([\s\S]*?)<\/id>/)?.[1]?.trim() || null;
      return { title, year: published ? Number(published) : null, venue: "arXiv preprint", url: id, source: "arXiv", tier: "L3" };
    })
    .filter((p) => p.title);
  return setCached(key, results);
}

// Shared by search_prior_art and computeScore's Temporal auto-enrichment — three
// independent, keyless, real sources queried in parallel; one failing (rate limit, timeout)
// shouldn't blank the other two.
async function searchLiteratureAllSources(query, { cutoffYear, cutoffDate } = {}) {
  const literature = [];
  const notes = [];
  const [ss, crossref, arxiv] = await Promise.allSettled([
    searchSemanticScholar(query, { cutoffYear }),
    searchCrossref(query, { cutoffDate }),
    searchArxiv(query, { cutoffDate }),
  ]);
  if (ss.status === "fulfilled") literature.push(...ss.value);
  else notes.push(`Semantic Scholar search failed: ${ss.reason.message}`);
  if (crossref.status === "fulfilled") literature.push(...crossref.value);
  else notes.push(`Crossref search failed: ${crossref.reason.message}`);
  if (arxiv.status === "fulfilled") literature.push(...arxiv.value);
  else notes.push(`arXiv search failed: ${arxiv.reason.message}`);
  return { literature, notes };
}

// Real per-year publication counts for [y0, y1] from OpenAlex's group_by=publication_year
// (free, keyless — no API key or registration required as of this writing). This is what
// backs the Temporal factor: an actual yearly trend, not the size of a handful of
// relevance-ranked search hits (P0-1 root cause (d)). Returns {} (not an error) on any
// failure — scoring.js treats an empty map as "no real data available" and falls back to
// the neutral 0.5, flagged is_fallback.
async function fetchYearlyLiteratureCounts(query, y0, y1) {
  const key = cacheKey(["openalex_years", query, y0, y1]);
  const cached = getCached(key);
  if (cached) return cached;
  try {
    const url = `https://api.openalex.org/works?search=${encodeURIComponent(query)}&filter=publication_year:${y0}-${y1}&group_by=publication_year&mailto=researchgap-tool@example.org`;
    const res = await fetch(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`OpenAlex ${res.status}`);
    const data = await res.json();
    const counts = {};
    for (const g of data.group_by || []) {
      const y = Number(g.key);
      if (Number.isFinite(y)) counts[y] = g.count;
    }
    return setCached(key, counts);
  } catch {
    return {};
  }
}

module.exports = { searchSemanticScholar, searchCrossref, searchArxiv, searchLiteratureAllSources, fetchYearlyLiteratureCounts };
