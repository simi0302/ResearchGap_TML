// Function-calling tools for the ResearchGap agent.
//
// - compute_patentability: wraps patentability.js. Pure backend computation — in-corpus BM25
//   prior-art retrieval, real per-year literature counts, and the four-factor score all run
//   here with no external credentials needed (see scoring.js). This is what keeps "backend
//   decides, AI only explains" true.
// - search_prior_art: web search for related academic literature (Semantic Scholar +
//   Crossref + arXiv — all free/keyless, queried in parallel via literature.js). Patent-office
//   / Google Patents / IEEE full-text web search is NOT available on this deployment: the
//   standalone Bing Search v7 API this used to depend on was retired by Microsoft (Aug 2025),
//   so that path has been removed rather than left silently dead. In-corpus retrieval
//   (compute_patentability's own prior_art[], via retrieval.js) is the primary prior-art
//   source; this tool only ever returns literature, and says so.
const { handlePatentabilityRequest } = require("./patentability");
const literature = require("./literature");

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
        "Searches Semantic Scholar, Crossref, and arXiv for related academic literature published on/before the cutoff date. Does NOT search patent offices or the general web (no such source is configured on this deployment) — for prior-art patents, rely on compute_patentability's own prior_art[] (in-corpus retrieval). Never invent results beyond what this returns.",
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
    const { literature: results, notes } = await literature.searchLiteratureAllSources(query, { cutoffYear, cutoffDate });
    return {
      query,
      literature: results,
      notes: [
        ...notes,
        "Patent-office/Google Patents/IEEE web search is not configured on this deployment — only the internal patent corpus (via compute_patentability) and the literature sources above are searchable. Report this limitation honestly rather than guessing patent numbers or claiming a broader search happened.",
      ],
    };
  }

  return { error: `Unknown tool: ${name}` };
}

module.exports = { TOOL_DEFINITIONS, executeTool };
