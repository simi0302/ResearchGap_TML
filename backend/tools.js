// Function-calling tools for the ResearchGap agent.
//
// - compute_patentability: wraps patentability.js. Pure backend computation — in-corpus BM25
//   prior-art retrieval, real per-year literature counts, and the four-factor score all run
//   here with no external credentials needed (see scoring.js). This is what keeps "backend
//   decides, AI only explains" true.
// - search_prior_art: real academic literature (Semantic Scholar + Crossref + arXiv — all
//   free/keyless, via literature.js) PLUS real general-web/patent-office search (Google
//   Patents, USPTO, etc.) via webSearch.js's Azure OpenAI Responses API `web_search` tool.
//   The old standalone Bing Search v7 dependency was retired by Microsoft (Aug 2025) and
//   removed rather than left silently dead; `web_search` on the Responses API is the real
//   replacement — same Azure OpenAI resource, same api-key, no new resource needed. Web
//   results are informational only (for the model to cite in prose) and never feed
//   computeScore() — in-corpus retrieval (compute_patentability's own prior_art[], via
//   retrieval.js) remains the sole, backend-controlled source for the Novelty score itself.
const { handlePatentabilityRequest } = require("./patentability");
const literature = require("./literature");
const webSearch = require("./webSearch");

const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "compute_patentability",
      description:
        "Computes the real Patentability Opportunity Score (POS) and its factor breakdown from the backend's own corpus, its own in-corpus prior-art retrieval, and real per-year literature counts. Always call this instead of estimating a score yourself. Returns needs_confirmation if the cutoff year or technical features can't be auto-detected, or out_of_scope if the text doesn't have enough in-scope technical content to score.",
      parameters: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["upload", "corpus"], description: "'corpus' if the user picked an existing patent by publication_number; 'upload' if they pasted/uploaded a research result." },
          patent_id: { type: "string", description: "Required for mode=corpus: the publication_number." },
          text: { type: "string", description: "Required for mode=upload on first call: the raw pasted/uploaded text, used to auto-detect a cutoff year and technical features." },
          publication_year: { type: "number", description: "Optional for mode=upload: overrides auto-detection once the user has confirmed a year." },
          features: {
            type: "array",
            description: "Optional for mode=upload: overrides auto-detection once the user has confirmed the feature list.",
            items: {
              type: "object",
              properties: { id: { type: "string" }, text: { type: "string" }, ipc: { type: "string" } },
              required: ["id", "text"],
            },
          },
          target_jurisdiction: { type: "string", enum: ["US", "EP", "JP", "TW"], description: "Jurisdiction to evaluate the Regional factor against. Defaults to the deployment's configured default if omitted." },
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
        "Searches Semantic Scholar, Crossref, and arXiv for related academic literature, AND searches the general public web (including patent offices and Google Patents) for supporting/prior-art context — both restricted to on/before the cutoff date where possible. For the Novelty score's own prior-art comparison, still rely on compute_patentability's own prior_art[] (in-corpus retrieval, backend-verified matched_features) — treat this tool's web results as supporting citations only, never as a replacement for that backend comparison. Never invent results beyond what this returns.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query, e.g. technical feature keywords." },
          cutoff_date: { type: "string", description: "ISO date (YYYY-MM-DD). Applied at the source — results published after this date are never returned." },
        },
        required: ["query"],
      },
    },
  },
];

async function executeTool(name, args) {
  if (name === "compute_patentability") {
    return handlePatentabilityRequest(args || {});
  }

  if (name === "search_prior_art") {
    const { query, cutoff_date: cutoffDate } = args || {};
    if (!query) return { error: "Missing query." };
    const cutoffYear = cutoffDate ? Number(String(cutoffDate).slice(0, 4)) : undefined;
    const [litResult, webResult] = await Promise.all([
      literature.searchLiteratureAllSources(query, { cutoffYear, cutoffDate }),
      webSearch.searchWeb(query, { cutoffDate }),
    ]);
    const notes = [...litResult.notes];
    if (webResult.note) notes.push(webResult.note);
    return {
      query,
      literature: litResult.literature,
      web: webResult.results,
      web_summary: webResult.summary || undefined,
      notes,
    };
  }

  return { error: `Unknown tool: ${name}` };
}

module.exports = { TOOL_DEFINITIONS, executeTool };
