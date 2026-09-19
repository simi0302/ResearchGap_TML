// Real general-web / patent-office search via Azure OpenAI's Responses API `web_search`
// tool (Bing-grounded, billed ~$0.014/request as of 2026-09 — see README). This is the
// fix for the gap search_prior_art used to disclose ("no patent-office/general-web search
// is configured") after the old Bing Search v7 dependency was removed — see corpus.js's
// header and the QA prep doc's former high-risk callout.
//
// Deliberately isolated from server.js's main chat.completions tool-calling loop: this is
// a single, separate POST to a DIFFERENT endpoint path (/openai/v1/responses instead of
// /openai/deployments/.../chat/completions) on the SAME Azure OpenAI resource, using the
// SAME api-key — no new Azure resource, no Entra ID, no Foundry project/connection. Kept
// out of the deterministic score: the model's text/summary here is informational only,
// surfaced through search_prior_art for the model to cite in prose — never fed into
// computeScore(). The one scoring use is externalPriorArt.js, which takes only candidate
// patent numbers/URLs from these results and verifies every one by fetching the page itself;
// nothing the model says about a patent is trusted. That boundary is what keeps "the backend
// decides the number" true even though this source's relevance judgment comes from the model.
const AZURE_OPENAI_ENDPOINT = process.env.AZURE_OPENAI_ENDPOINT;
const AZURE_OPENAI_API_KEY = process.env.AZURE_OPENAI_API_KEY;
const AZURE_OPENAI_DEPLOYMENT = process.env.AZURE_OPENAI_DEPLOYMENT;

async function searchWeb(query, { cutoffDate } = {}) {
  if (!AZURE_OPENAI_ENDPOINT || !AZURE_OPENAI_API_KEY || !AZURE_OPENAI_DEPLOYMENT) {
    return { results: [], summary: "", note: "Web search is not configured on this deployment (missing Azure OpenAI credentials)." };
  }
  const cutoffLine = cutoffDate
    ? ` Only include sources published on or before ${cutoffDate}; ignore anything newer than that.`
    : "";
  const input =
    `Search the public web — including patent offices and Google Patents (patents.google.com) as well as ` +
    `general engineering sources — for: ${query}.${cutoffLine} Report only what you actually find, with an ` +
    `inline citation for every fact. If nothing relevant turns up, say so plainly instead of guessing.`;

  try {
    const url = `${AZURE_OPENAI_ENDPOINT.replace(/\/$/, "")}/openai/v1/responses`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-key": AZURE_OPENAI_API_KEY },
      body: JSON.stringify({
        model: AZURE_OPENAI_DEPLOYMENT,
        tools: [{ type: "web_search" }],
        include: ["web_search_call.action.sources"],
        input,
      }),
    });
    if (!res.ok) {
      const errText = await res.text();
      return { results: [], summary: "", note: `Web search failed (HTTP ${res.status}): ${errText.slice(0, 200)}` };
    }
    const data = await res.json();
    const output = Array.isArray(data.output) ? data.output : [];
    const message = output.find((item) => item.type === "message");
    const searchCalls = output.filter((item) => item.type === "web_search_call");
    if (!message) return { results: [], summary: "", note: "Web search ran but returned no message." };

    const content = (message.content || [])[0] || {};
    const annotations = (content.annotations || []).filter((a) => a.type === "url_citation");

    const sourceUrls = [];
    for (const call of searchCalls) {
      for (const s of call.action?.sources || []) {
        if (s.url && !sourceUrls.includes(s.url)) sourceUrls.push(s.url);
      }
    }

    // Prefer real inline citations (title + the exact sentence they support); fall back to
    // the raw candidate URLs the search surfaced if the model didn't cite anything inline.
    const results = annotations.length
      ? annotations.map((a) => ({ title: a.title || a.url, url: a.url, source: "Web (Bing)", tier: "L1" }))
      : sourceUrls.slice(0, 5).map((u) => ({ title: u, url: u, source: "Web (Bing)", tier: "L1" }));

    return {
      results,
      summary: content.text || "",
      note: results.length ? null : "Web search ran but found nothing relevant to this query.",
    };
  } catch (err) {
    return { results: [], summary: "", note: `Web search failed: ${err.message}` };
  }
}

module.exports = { searchWeb };
