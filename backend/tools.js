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
//   results are informational only (for the model to cite in prose); the model's words never
//   feed computeScore(). Separately, externalPriorArt.js re-uses the web search purely to find
//   candidate patent numbers, then fetches/parses/date-checks each page itself, so verified
//   external patents join the corpus for Novelty — backend-controlled end to end.
const { handlePatentabilityRequest } = require("./patentability");
const literature = require("./literature");
const webSearch = require("./webSearch");
const { topicLandscape } = require("./landscape");

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
        "Searches Semantic Scholar, Crossref, and arXiv for related academic literature, AND searches the general public web (including patent offices and Google Patents) for supporting/prior-art context — both restricted to on/before the cutoff date where possible. For the Novelty score's own prior-art comparison, still rely on compute_patentability's own prior_art[] (in-corpus retrieval, backend-verified matched_features) — treat this tool's web results as supporting citations only, never as a replacement for that backend comparison (the backend separately finds, fetches and verifies external patents itself for Novelty — they appear in compute_patentability's prior_art[] with source: 'external'). Never invent results beyond what this returns.",
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
  {
    type: "function",
    function: {
      name: "topic_landscape",
      description:
        "Deterministic landscape of a technology topic, for questions like 'is X crowded?', 'who files patents on X?', 'is research on X growing faster than patents?' when the user has NOT uploaded a document. Returns counts over the fixed 2,799-patent corpus (by year, jurisdiction, IPC group, applicant HHI, example patents with links) and over the ResearchGap knowledge base of papers (by year, most-cited papers), plus the research-to-patent ratio. Every number is computed by the backend; quote them, never estimate.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "The topic in the user's words, e.g. 'network slicing digital twin' (Chinese or English; synonyms are handled)." },
          cutoff_year: { type: "number", description: "Optional: count only documents published on/before Dec 31 of this year." },
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
      literature.searchWithKnowledge(query, { cutoffYear, cutoffDate }),
      webSearch.searchWeb(query, { cutoffDate }),
    ]);
    const notes = [...litResult.notes];
    if (webResult.note) notes.push(webResult.note);
    const brief = (p) => ({ title: p.title, year: p.year, venue: p.venue, url: p.url, source: p.source, tier: p.tier, abstract: p.abstract ? String(p.abstract).slice(0, 300) : undefined });
    return {
      query,
      // Retrieved from ResearchGap's persistent knowledge base (stored from earlier searches
      // and the offline crawl) — available even when the live sources fail.
      knowledge_base: litResult.local.map((p) => ({ ...brief(p), type: p.type, relevance: p.relevance })),
      literature: litResult.live.map(brief),
      knowledge_base_update: litResult.learned,
      web: webResult.results,
      web_summary: webResult.summary || undefined,
      notes,
    };
  }

  if (name === "topic_landscape") {
    const { query, cutoff_year: cutoffYear } = args || {};
    if (!query) return { error: "Missing query." };
    const y = Number(cutoffYear);
    return topicLandscape(query, { cutoffYear: Number.isInteger(y) && y >= 1990 && y <= 2030 ? y : undefined });
  }

  return { error: `Unknown tool: ${name}` };
}

module.exports = { TOOL_DEFINITIONS, executeTool };
