// Function-calling tools for the ResearchGap agent (§③/§④ of the skill docs — "Agent 廣蒐前案與文獻，
// backend 計分"). Two tools:
//
// - compute_patentability: wraps patentability.js. Fully working right now — pure local
//   computation, no external credentials needed. This is what keeps "backend decides, AI
//   explains" true once a real model is wired up.
// - search_prior_art: web search for prior art / related work. The Semantic Scholar half works
//   right now with no key (their public Graph API is free and keyless). The general
//   patents/web half needs BING_SEARCH_KEY — until that's set it returns an honest
//   "unavailable" result instead of fabricating hits, same anti-fabrication rule as everywhere
//   else in this backend.
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

async function executeTool(name, args) {
  if (name === "compute_patentability") {
    return handlePatentabilityRequest(args || {});
  }

  if (name === "search_prior_art") {
    const { query, type = "both" } = args || {};
    if (!query) return { error: "Missing query." };

    const result = { query, literature: [], patents: [], notes: [] };

    if (type === "literature" || type === "both") {
      try {
        result.literature = await searchSemanticScholar(query);
      } catch (err) {
        result.notes.push(`Semantic Scholar search failed: ${err.message}`);
      }
    }

    if (type === "patents" || type === "both") {
      try {
        const patentResult = await searchBingPatents(query);
        if (patentResult && patentResult.unavailable) {
          result.notes.push(`Patent/web search unavailable: ${patentResult.reason} Report this honestly to the user rather than guessing patent numbers.`);
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
