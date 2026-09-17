// Function-calling tools for the ResearchGap agent (§③/§④ of the skill docs — "Agent 廣蒐前案與文獻，
// backend 計分"). Two tools:
//
// - compute_patentability: wraps patentability.js. Fully working right now — pure local
//   computation, no external credentials needed. This is what keeps "backend decides, AI
//   explains" true once a real model is wired up.
// - search_prior_art: web search for prior art / related work. The literature half works
//   right now with no key at all — Semantic Scholar, Crossref, and arXiv are all free/keyless
//   public APIs, queried in parallel (one failing doesn't blank the others). The
//   patents/general-web half (Google Patents, patent office sites, IEEE Xplore full-text
//   search) needs BING_SEARCH_KEY — until that's set it returns an honest "unavailable"
//   result instead of fabricating hits, same anti-fabrication rule as everywhere else in
//   this backend.
const { handlePatentabilityRequest } = require("./patentability");

const { BING_SEARCH_KEY, BING_SEARCH_ENDPOINT = "https://api.bing.microsoft.com/v7.0/search" } = process.env;

const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "compute_patentability",
      description:
        "Computes the real POS (Patent Opportunity Score) and its factor breakdown from the backend's own corpus and any prior_art/literature you've already gathered from the web. Always call this instead of estimating a score yourself. Returns needs_confirmation instead of a score if the cutoff year or technical features aren't confirmed yet.",
      parameters: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["upload", "corpus"], description: "'corpus' if the user picked an existing patent by publication_number; 'upload' if they pasted/uploaded a research result." },
          patent_id: { type: "string", description: "Required for mode=corpus: the publication_number." },
          text: { type: "string", description: "Required for mode=upload on first call: the raw pasted/uploaded text, used to suggest a cutoff year and candidate features." },
          publication_year: { type: "number", description: "Required for mode=upload once the user has confirmed it." },
          features: {
            type: "array",
            description: "Required for mode=upload once the user has confirmed the feature list.",
            items: {
              type: "object",
              properties: { id: { type: "string" }, text: { type: "string" }, ipc: { type: "string" } },
              required: ["id", "text"],
            },
          },
          prior_art: {
            type: "array",
            description: "Prior-art patents you found via search_prior_art, each with which features of the case they overlap.",
            items: {
              type: "object",
              properties: {
                patent_no: { type: "string" },
                year: { type: "number" },
                matched_features: { type: "array", items: { type: "string" } },
              },
              required: ["patent_no"],
            },
          },
          literature: {
            type: "array",
            description: "Related academic papers you found via search_prior_art, each with a publication year.",
            items: {
              type: "object",
              properties: { title: { type: "string" }, year: { type: "number" }, url: { type: "string" } },
              required: ["year"],
            },
          },
        },
        required: ["mode"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_prior_art",
      description:
        "Searches the public web for prior-art patents and related academic literature. Use this before calling compute_patentability with prior_art/literature. Never invent search results — if a source returns unavailable, tell the user honestly.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query, e.g. technical feature keywords." },
          type: { type: "string", enum: ["patents", "literature", "both"], default: "both" },
          cutoff_date: { type: "string", description: "ISO date (YYYY-MM-DD). Results published after this date must be excluded/flagged by you per the 基準日鐵律." },
        },
        required: ["query"],
      },
    },
  },
];

async function searchSemanticScholar(query, limit = 5) {
  const url = `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(query)}&limit=${limit}&fields=title,year,venue,url,abstract`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Semantic Scholar ${res.status}`);
  const data = await res.json();
  return (data.data || []).map((p) => ({
    title: p.title,
    year: p.year ?? null,
    venue: p.venue || null,
    url: p.url || (p.paperId ? `https://www.semanticscholar.org/paper/${p.paperId}` : null),
    source: "Semantic Scholar",
    tier: "L2",
  }));
}

async function searchBingPatents(query, limit = 5) {
  if (!BING_SEARCH_KEY) return { unavailable: true, reason: "BING_SEARCH_KEY not configured yet." };
  const patentQuery = `${query} (site:patents.google.com OR site:gpss.tipo.gov.tw OR site:ieeexplore.ieee.org)`;
  const url = `${BING_SEARCH_ENDPOINT}?q=${encodeURIComponent(patentQuery)}&count=${limit}`;
  const res = await fetch(url, { headers: { "Ocp-Apim-Subscription-Key": BING_SEARCH_KEY } });
  if (!res.ok) throw new Error(`Bing Search ${res.status}`);
  const data = await res.json();
  return (data.webPages?.value || []).map((r) => ({
    title: r.name,
    url: r.url,
    snippet: r.snippet,
    source: "web (Bing)",
    tier: r.url.includes("ieeexplore.ieee.org") ? "L2" : "L1",
  }));
}

// Crossref: free, keyless, no registration — indexes DOI-bearing works across journals
// and conferences (including most IEEE Xplore / ACM Digital Library papers), so this is
// real L2 coverage beyond Semantic Scholar even without any API key configured.
async function searchCrossref(query, limit = 5) {
  const url = `https://api.crossref.org/works?query=${encodeURIComponent(query)}&rows=${limit}`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`Crossref ${res.status}`);
  const data = await res.json();
  return (data.message?.items || []).map((p) => ({
    title: Array.isArray(p.title) ? p.title[0] : p.title || null,
    year: p.issued?.["date-parts"]?.[0]?.[0] ?? null,
    venue: p["container-title"]?.[0] || null,
    url: p.URL || (p.DOI ? `https://doi.org/${p.DOI}` : null),
    source: "Crossref",
    tier: "L2",
  })).filter((p) => p.title);
}

// arXiv: free, keyless, no registration — real preprints (L3, per 【來源層級】: usable
// but must be flagged "未經審查"). Atom XML response, parsed with a small regex scan
// rather than pulling in an XML dependency for four fields.
async function searchArxiv(query, limit = 5) {
  const url = `http://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(query)}&start=0&max_results=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`arXiv ${res.status}`);
  const xml = await res.text();
  const entries = xml.split("<entry>").slice(1);
  return entries.map((e) => {
    const title = e.match(/<title>([\s\S]*?)<\/title>/)?.[1]?.replace(/\s+/g, " ").trim() || null;
    const published = e.match(/<published>(\d{4})-/)?.[1];
    const id = e.match(/<id>([\s\S]*?)<\/id>/)?.[1]?.trim() || null;
    return {
      title,
      year: published ? Number(published) : null,
      venue: "arXiv preprint",
      url: id,
      source: "arXiv",
      tier: "L3",
    };
  }).filter((p) => p.title);
}

// Shared by search_prior_art and the auto-enrichment below — three independent, keyless,
// real sources queried in parallel; a single source failing (rate limit, timeout)
// shouldn't blank out the other two. Semantic Scholar + Crossref between them cover most
// peer-reviewed venues (including IEEE Xplore/ACM-indexed papers via DOI), arXiv covers
// preprints.
async function searchLiteratureAllSources(query) {
  const literature = [];
  const notes = [];
  const [ss, crossref, arxiv] = await Promise.allSettled([
    searchSemanticScholar(query),
    searchCrossref(query),
    searchArxiv(query),
  ]);
  if (ss.status === "fulfilled") literature.push(...ss.value);
  else notes.push(`Semantic Scholar search failed: ${ss.reason.message}`);
  if (crossref.status === "fulfilled") literature.push(...crossref.value);
  else notes.push(`Crossref search failed: ${crossref.reason.message}`);
  if (arxiv.status === "fulfilled") literature.push(...arxiv.value);
  else notes.push(`arXiv search failed: ${arxiv.reason.message}`);
  return { literature, notes };
}

async function executeTool(name, args) {
  if (name === "compute_patentability") {
    let result = handlePatentabilityRequest(args || {});
    // Auto-enrich the Temporal factor with a real literature search before returning,
    // instead of leaving it at the neutral 0.5 fallback whenever the model didn't already
    // supply literature[] itself. This is deterministic-backend behavior, not dependent on
    // the model remembering to call search_prior_art first — same "don't rely on model
    // initiative for something the backend can just do" pattern as elsewhere in this file.
    // Only literature (year-only data) is safe to auto-fill this way; prior_art/Novelty
    // needs per-result feature-overlap judgment (matched_features) that a keyword search
    // can't produce on its own, so that one still depends on the model calling
    // search_prior_art itself (see systemPrompt.js Stage 2).
    const hasFeatures = !result.needs_confirmation && Array.isArray(result.features) && result.features.length > 0;
    const suppliedLiterature = Array.isArray(args?.literature) && args.literature.length > 0;
    if (hasFeatures && !suppliedLiterature) {
      const query = result.features.slice(0, 3).map((f) => f.text).join(" ");
      const { literature } = await searchLiteratureAllSources(query).catch(() => ({ literature: [] }));
      if (literature.length > 0) {
        const enriched = handlePatentabilityRequest({
          mode: args.mode,
          patent_id: args.patent_id,
          case_id: result.case_id,
          publication_year: result.cutoff_year,
          features: result.features,
          prior_art: args?.prior_art,
          literature,
          target_jurisdiction: args?.target_jurisdiction,
        });
        result = {
          ...enriched,
          auto_detected_cutoff_year: result.auto_detected_cutoff_year,
          auto_detected_features: result.auto_detected_features,
          year_candidates: result.year_candidates,
          literature_auto_searched: true,
        };
      }
    }
    return result;
  }

  if (name === "search_prior_art") {
    const { query, type = "both" } = args || {};
    if (!query) return { error: "Missing query." };

    const result = { query, literature: [], patents: [], notes: [] };

    if (type === "literature" || type === "both") {
      const { literature, notes } = await searchLiteratureAllSources(query);
      result.literature.push(...literature);
      result.notes.push(...notes);
    }

    if (type === "patents" || type === "both") {
      try {
        const patentResult = await searchBingPatents(query);
        if (patentResult && patentResult.unavailable) {
          result.notes.push(
            `Patent/web search unavailable: ${patentResult.reason} This means live patent-office/Google Patents/IEEE web search is not configured on this deployment (needs a Bing Search API key) — only the internal 2,799-patent corpus and the literature sources above (Semantic Scholar/Crossref/arXiv) are searchable right now. Report this limitation honestly to the user rather than guessing patent numbers or claiming a broader search happened.`
          );
        } else {
          result.patents = patentResult;
        }
      } catch (err) {
        result.notes.push(`Patent web search failed: ${err.message}`);
      }
    }

    return result;
  }

  return { error: `Unknown tool: ${name}` };
}

module.exports = { TOOL_DEFINITIONS, executeTool };
