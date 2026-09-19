require("dotenv").config();
const express = require("express");
const cors = require("cors");
const buildSystemPrompt = require("./systemPrompt");
const { handlePatentabilityRequest } = require("./patentability");
const { TOOL_DEFINITIONS, executeTool } = require("./tools");
const scoring = require("./scoring");
const { t } = require("./i18n");

const {
  AZURE_OPENAI_ENDPOINT,
  AZURE_OPENAI_API_KEY,
  AZURE_OPENAI_DEPLOYMENT,
  AZURE_OPENAI_DEPLOYMENT_ANALYSIS = AZURE_OPENAI_DEPLOYMENT,
  AZURE_OPENAI_API_VERSION = "2024-06-01",
  ALLOWED_ORIGIN = "*",
  DEFAULT_LANG = "en",
  PORT = 8080,
} = process.env;

const app = express();
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json({ limit: "1mb" }));

function resolveLang(body) {
  return body?.lang === "zh" ? "zh" : body?.lang === "en" ? "en" : DEFAULT_LANG === "zh" ? "zh" : "en";
}

// Keep the request bounded — this both caps cost against the team's Azure
// credit and stays within the model's context window.
const MAX_HISTORY_MESSAGES = 16;
// Tool-calling rounds are separately bounded so a confused model can't loop forever
// and burn through the Azure credit on its own.
const MAX_TOOL_ROUNDS = 4;
// P0-6 item 4: replies that carry a full POS breakdown + white-space table + attorney
// questions + references routinely got cut off at the old 1200-token cap. 4000 covers a
// full one-shot analysis; if the model still hits the cap (finish_reason === "length"),
// one automatic continuation call is appended (see continueIfTruncated below) rather than
// silently returning a cut-off reply.
const MAX_TOKENS = 4000;

async function callAzureChat(messages, { deployment = AZURE_OPENAI_DEPLOYMENT_ANALYSIS, maxTokens = MAX_TOKENS } = {}) {
  const url = `${AZURE_OPENAI_ENDPOINT.replace(/\/$/, "")}/openai/deployments/${deployment}/chat/completions?api-version=${AZURE_OPENAI_API_VERSION}`;
  const azureRes = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": AZURE_OPENAI_API_KEY,
    },
    body: JSON.stringify({
      messages,
      tools: TOOL_DEFINITIONS,
      temperature: 0.3,
      max_tokens: maxTokens,
    }),
  });
  if (!azureRes.ok) {
    const detail = await azureRes.text();
    const err = new Error(`Azure OpenAI error (${azureRes.status})`);
    err.detail = detail;
    err.status = azureRes.status;
    throw err;
  }
  return azureRes.json();
}

// Session doc storage (P0-6 item 7): the previous design only carried the uploaded
// document's text within the single turn it was attached to (re-derived per request from
// the raw chat history), so it silently vanished once MAX_HISTORY_MESSAGES trimmed that
// turn out of an older conversation. Store it server-side per session id instead, with a
// TTL, and let the frontend reference it by id on later turns — an in-memory Map is fine
// for a single-instance F1 App Service deployment (no persistence needed across restarts,
// per the privacy note: nothing is meant to outlive the session anyway).
const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
const sessionDocs = new Map(); // sessionId -> { text, expires }
function pruneSessions() {
  const now = Date.now();
  for (const [id, v] of sessionDocs) if (v.expires < now) sessionDocs.delete(id);
}
setInterval(pruneSessions, 10 * 60 * 1000).unref();

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, configured: Boolean(AZURE_OPENAI_ENDPOINT && AZURE_OPENAI_API_KEY && AZURE_OPENAI_DEPLOYMENT) });
});

// Cutoff filtering, feature extraction, in-corpus prior-art retrieval, and the four-factor
// patentability score are all computed here (backend), never by the model. See
// patentability.js / scoring.js / corpus.js / features.js / retrieval.js.
app.post("/api/patentability", async (req, res) => {
  const lang = resolveLang(req.body);
  try {
    const result = await handlePatentabilityRequest(req.body || {});
    if (result.error) return res.status(400).json(result);
    res.json(result);
  } catch (err) {
    console.error("Patentability handler failed", err);
    res.status(500).json({ error: t(lang).errors.scoringFailed });
  }
});

// P1 item 9: re-rank a case under each weight ±5%/±10% and report whether grade/rank
// changes — a small "weight sensitivity" check the frontend can show alongside the score.
app.post("/api/sensitivity", async (req, res) => {
  const lang = resolveLang(req.body);
  try {
    const result = await handlePatentabilityRequest(req.body || {});
    if (result.error) return res.status(400).json(result);
    if (result.needs_confirmation || result.out_of_scope) return res.status(400).json(result);
    res.json(scoring.sensitivityAnalysis(result.breakdown, lang));
  } catch (err) {
    console.error("Sensitivity handler failed", err);
    res.status(500).json({ error: t(lang).errors.scoringFailed });
  }
});

// Session doc storage endpoints (P0-6 item 7) — the frontend uploads extracted text once
// and gets a session id back, then references that id in later /api/chat turns instead of
// re-sending (and risking losing) the full document text every time.
app.post("/api/session/document", (req, res) => {
  const text = req.body?.text;
  if (typeof text !== "string" || !text.trim()) return res.status(400).json({ error: "Missing text." });
  const sessionId = req.body?.session_id || `S-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  sessionDocs.set(sessionId, { text, expires: Date.now() + SESSION_TTL_MS });
  res.json({ session_id: sessionId, chars: text.length });
});

app.delete("/api/session/:id", (req, res) => {
  sessionDocs.delete(req.params.id);
  res.json({ ok: true });
});

app.post("/api/chat", async (req, res) => {
  // The website agent is English-only: ignore body.lang and DEFAULT_LANG here so neither a
  // stray client value nor a deployed DEFAULT_LANG=zh can switch the chat (or its tool
  // outputs) to Chinese. resolveLang() still serves the scoring endpoints above.
  const lang = "en";
  const s = t(lang);
  if (!AZURE_OPENAI_ENDPOINT || !AZURE_OPENAI_API_KEY || !AZURE_OPENAI_DEPLOYMENT) {
    return res.status(500).json({ error: s.errors.missingAzureConfig });
  }

  // Accepts either { history: [...including the latest user turn] } or { message: "...",
  // history: [...prior turns only] } — support both so this backend works unmodified
  // whichever shape the caller sends.
  const history = Array.isArray(req.body?.history) ? req.body.history : [];
  const rawTurns =
    typeof req.body?.message === "string" && req.body.message.trim()
      ? [...history, { role: "user", content: req.body.message }]
      : history;
  const turns = rawTurns
    .filter((m) => (m?.role === "user" || m?.role === "assistant") && typeof m?.content === "string")
    .slice(-MAX_HISTORY_MESSAGES)
    .map((m) => ({ role: m.role, content: m.content }));

  if (turns.length === 0) {
    return res.status(400).json({ error: s.errors.missingMessage });
  }

  // Ground-truth override for the uploaded document's raw text (see buildCallMessages
  // below for the same pattern applied to table formatting). The compute_patentability
  // tool's `text` parameter asks the *model* to copy that same text back into a
  // function-call argument — gpt-4.1-mini was observed doing this unreliably (paraphrasing
  // or truncating it), which silently broke cutoff-year detection and feature extraction.
  // Prefer a stored session document (P0-6 item 7) if session_id is given; otherwise fall
  // back to parsing it out of the chat history the same way as before, so this endpoint
  // still works unmodified for callers that don't use session storage.
  let uploadedDocText = null;
  const sessionId = req.body?.session_id;
  if (sessionId && sessionDocs.has(sessionId)) {
    const entry = sessionDocs.get(sessionId);
    entry.expires = Date.now() + SESSION_TTL_MS; // touch on use
    uploadedDocText = entry.text;
  }
  if (!uploadedDocText) {
    for (const turn of turns) {
      if (turn.role !== "user") continue;
      const m = turn.content.match(/-----\s*Uploaded document:.*?-----\n([\s\S]*)/);
      if (m) uploadedDocText = m[1].trim();
    }
  }

  // Optional: caller (frontend) first calls POST /api/patentability to get real backend
  // numbers, then passes that JSON back here as `context` so the model explains/cites it
  // instead of computing or guessing its own. (Also reachable mid-conversation via the
  // compute_patentability tool below.)
  const systemMessages = [{ role: "system", content: buildSystemPrompt(lang) }];
  if (req.body?.context && typeof req.body.context === "object") {
    systemMessages.push({
      role: "system",
      content: `[BACKEND COMPUTATION RESULT — JSON, do not alter, only cite/explain]\n${JSON.stringify(req.body.context)}`,
    });
  }

  // Per-turn table steering: gpt-4.1-mini reliably follows the systemPrompt's Stage rules
  // right after a tool call, but on a *second* question in the same conversation (e.g. a
  // white-space question right after a POS question) it was observed just re-pasting the
  // previous turn's Stage 1 table instead of switching to Stage 3 — the systemPrompt's
  // static Stage-selection rule sits too far from the end of the context for a small model
  // to reliably re-apply every turn. Detect the latest user turn's intent with a keyword
  // check (deterministic, not model-guessed) and re-append a short reminder as the LAST
  // message before every model call in this request, so it's always the freshest
  // instruction, even across tool-calling rounds.
  const latestUserContent = [...turns].reverse().find((turn) => turn.role === "user")?.content || "";
  const wantsWhitespace = /white[\s-]?space|whitespace|gap|technology combination|白地|機會缺口|技術組合/i.test(latestUserContent);
  const wantsPOS = /patentability|opportunity score|\bPOS\b|可專利性|機會分數/i.test(latestUserContent);
  let steeringMessage = null;
  if (wantsWhitespace && !wantsPOS) {
    steeringMessage = {
      role: "system",
      content:
        "[THIS TURN ONLY] The user's message is asking about white space / technology combinations. This reply must ONLY output the Stage 3 combination table, copying combination_whitespace from the compute_patentability result row by row. Do not output the Stage 1 sub-score table this turn, and do not re-paste a table already given in a previous turn.",
    };
  } else if (wantsPOS && !wantsWhitespace) {
    steeringMessage = {
      role: "system",
      content:
        "[THIS TURN ONLY] The user's message is asking about the POS / opportunity score. This reply must ONLY output the Stage 1 sub-score table, copying breakdown from the compute_patentability result row by row.",
    };
  }
  const buildCallMessages = (base) => (steeringMessage ? [...base, steeringMessage] : base);

  // Hard guarantee, not just a prompt hint: gpt-4.1-mini was observed (reproducibly, even
  // single-turn) ignoring an explicit white-space question and re-answering with the Stage
  // 1 POS table instead of Stage 3's technology-combination table — a prompt is a request,
  // not a contract, and this project's "backend decides, AI only explains" rule means the
  // table itself shouldn't depend on the model getting the format right. So for white-space
  // specifically, the reply is replaced with a deterministically rendered table straight
  // from the same JSON the model sees, rather than trusted to the model's own formatting.
  function escapeMd(v) {
    return String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
  }
  function statusLabel(status) {
    if (status === "gap") return "Potential White Space";
    if (status === "crowded") return "Crowded";
    return "Developing";
  }
  function renderWhitespaceTable(rows) {
    const body = rows.map(
      (r) => `| ${escapeMd(r.combo_a)} (${r.ipc_a}) × ${escapeMd(r.combo_b)} (${r.ipc_b}) | ${r.count} | ${statusLabel(r.status)} | ${escapeMd(r.evidence_en)} |`
    );
    return ["| Combination | Patents in population | Status | Evidence |", "|---|---|---|---|", ...body].join("\n");
  }

  let messages = [...systemMessages, ...turns];
  const toolTrace = [];
  const usageTotal = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const accumulateUsage = (data) => {
    const u = data?.usage;
    if (!u) return;
    usageTotal.prompt_tokens += u.prompt_tokens || 0;
    usageTotal.completion_tokens += u.completion_tokens || 0;
    usageTotal.total_tokens += u.total_tokens || 0;
  };

  try {
    let data = await callAzureChat(buildCallMessages(messages));
    accumulateUsage(data);
    let round = 0;

    while (round < MAX_TOOL_ROUNDS) {
      const message = data?.choices?.[0]?.message;
      const toolCalls = message?.tool_calls;
      if (!toolCalls || toolCalls.length === 0) break;

      messages = [...messages, message];
      for (const call of toolCalls) {
        let args = {};
        try {
          args = JSON.parse(call.function.arguments || "{}");
        } catch {
          // malformed tool-call arguments — fall through with empty args, tool will
          // report the missing required fields back to the model rather than crash.
        }
        // See the ground-truth override comment above — always prefer the real
        // extracted document text over whatever the model relayed into the argument.
        if (call.function.name === "compute_patentability" && args.mode === "upload" && uploadedDocText) {
          args.text = uploadedDocText;
        }
        if (!args.lang) args.lang = lang;
        let result;
        try {
          result = await executeTool(call.function.name, args);
        } catch (err) {
          result = { error: `Tool ${call.function.name} failed: ${err.message}` };
        }
        toolTrace.push({ tool: call.function.name, args, result });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(result),
        });
      }

      round += 1;
      data = await callAzureChat(buildCallMessages(messages));
      accumulateUsage(data);
    }

    let finishMessage = data?.choices?.[0]?.message;
    let reply = finishMessage?.content;
    // P0-6 item 4: auto-continue once if the model was cut off mid-reply instead of
    // silently returning a truncated table/reference list.
    if (data?.choices?.[0]?.finish_reason === "length" && typeof reply === "string") {
      const continued = await callAzureChat(
        buildCallMessages([...messages, finishMessage, { role: "user", content: "Continue exactly where you left off." }])
      );
      accumulateUsage(continued);
      const more = continued?.choices?.[0]?.message?.content;
      if (typeof more === "string") reply = reply + more;
    }
    if (typeof reply !== "string") {
      return res.status(502).json({ error: s.errors.azureBadResponse });
    }

    // See the "Hard guarantee" block above buildCallMessages. Only the white-space case
    // gets a deterministic *replacement* (not just a prepend) — repeated local testing
    // showed gpt-4.1-mini reliably re-answers with the Stage 1 POS table instead of the
    // Stage 3 white-space table even on a single-turn, unambiguous question, so the
    // model's own text for that case is actively wrong, not just incomplete. The POS case
    // was verified working correctly on its own, so it's left alone.
    let finalReply = reply;
    if (wantsWhitespace && !wantsPOS) {
      const lastScored = [...toolTrace]
        .reverse()
        .find((call) => call.tool === "compute_patentability" && call.result && !call.result.needs_confirmation && call.result.score !== undefined);
      if (lastScored) {
        const r = lastScored.result;
        const rows = Array.isArray(r.combination_whitespace) ? r.combination_whitespace : [];
        const table = rows.length
          ? `Using ${r.cutoff_year} as the cutoff, ${rows.filter((x) => x.status === "gap").length} potential white-space combinations were found (technology classification: ${r.subtech_label}).\n\n${renderWhitespaceTable(rows)}\n\nSource: ResearchGap backend computation, N=2,799, extracted from GPSS.`
          : `Using ${r.cutoff_year} as the cutoff, this case's technology classification (${r.subtech_label}) is not in a known technology group, so no combination white-space table is available.`;
        const leakedWrongTopic = /Novelty|Crowding|Temporal factor/i.test(reply);
        finalReply = leakedWrongTopic ? table : `${table}\n\n---\n\n${reply}`;
      }
    }

    // Real token usage as reported by Azure OpenAI for this turn (summed across every
    // tool-calling round it took) — not estimated, so the UI can show real cost, not a guess.
    res.json({ reply: finalReply, tool_calls: toolTrace, usage: usageTotal, lang });
  } catch (err) {
    console.error("Chat handler failed", err, err.detail || "");
    if (err.status) return res.status(502).json({ error: s.errors.azureError(err.status) });
    res.status(500).json({ error: s.errors.azureCallFailed });
  }
});

app.listen(PORT, () => {
  console.log(`ResearchGap agent backend listening on :${PORT}`);
});
