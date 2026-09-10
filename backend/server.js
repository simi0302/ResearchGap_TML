require("dotenv").config();
const express = require("express");
const cors = require("cors");
const systemPrompt = require("./systemPrompt");
const { handlePatentabilityRequest } = require("./patentability");
const { TOOL_DEFINITIONS, executeTool } = require("./tools");

const {
  AZURE_OPENAI_ENDPOINT,
  AZURE_OPENAI_API_KEY,
  AZURE_OPENAI_DEPLOYMENT,
  AZURE_OPENAI_API_VERSION = "2024-06-01",
  ALLOWED_ORIGIN = "*",
  PORT = 8080,
} = process.env;

const app = express();
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json({ limit: "1mb" }));

// Keep the request bounded — this both caps cost against the team's Azure
// credit and stays within the model's context window.
const MAX_HISTORY_MESSAGES = 16;
// Tool-calling rounds are separately bounded so a confused model can't loop forever
// and burn through the Azure credit on its own.
const MAX_TOOL_ROUNDS = 4;

async function callAzureChat(messages) {
  const url = `${AZURE_OPENAI_ENDPOINT.replace(/\/$/, "")}/openai/deployments/${AZURE_OPENAI_DEPLOYMENT}/chat/completions?api-version=${AZURE_OPENAI_API_VERSION}`;
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
      max_tokens: 1200,
    }),
  });
  if (!azureRes.ok) {
    const detail = await azureRes.text();
    const err = new Error(`Azure OpenAI 回應錯誤（${azureRes.status}）`);
    err.detail = detail;
    err.status = azureRes.status;
    throw err;
  }
  return azureRes.json();
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, configured: Boolean(AZURE_OPENAI_ENDPOINT && AZURE_OPENAI_API_KEY && AZURE_OPENAI_DEPLOYMENT) });
});

// §③/§④/§⑤ of ResearchGap_Agent_Skill_v2.md: cutoff filtering, feature extraction, and the
// five-factor patentability score are all computed here (backend), never by the model.
// See patentability.js / scoring.js / corpus.js / features.js.
app.post("/api/patentability", (req, res) => {
  try {
    const result = handlePatentabilityRequest(req.body || {});
    if (result.error) return res.status(400).json(result);
    res.json(result);
  } catch (err) {
    console.error("Patentability handler failed", err);
    res.status(500).json({ error: "後端計算可專利性初判分數時發生錯誤。" });
  }
});

app.post("/api/chat", async (req, res) => {
  if (!AZURE_OPENAI_ENDPOINT || !AZURE_OPENAI_API_KEY || !AZURE_OPENAI_DEPLOYMENT) {
    return res.status(500).json({ error: "Backend is missing Azure OpenAI configuration (AZURE_OPENAI_ENDPOINT / AZURE_OPENAI_API_KEY / AZURE_OPENAI_DEPLOYMENT)." });
  }

  // Accepts either { history: [...including the latest user turn] } or the real frontend's
  // { message: "...", history: [...prior turns only] } (see frontend/src/lib/agent.ts) — support
  // both so this backend works unmodified whichever caller is talking to it.
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
    return res.status(400).json({ error: "Missing message/history." });
  }

  // Optional: caller (frontend) first calls POST /api/patentability to get real backend
  // numbers, then passes that JSON back here as `context` so the model explains/cites it
  // instead of computing or guessing its own — keeps the §③ "分工鐵律" intact end-to-end.
  // (This is now also reachable mid-conversation via the compute_patentability tool below,
  // so `context` is mainly useful for seeding a conversation that starts from a UI action
  // like "score this patent" rather than a typed question.)
  const systemMessages = [{ role: "system", content: systemPrompt }];
  if (req.body?.context && typeof req.body.context === "object") {
    systemMessages.push({
      role: "system",
      content: `【後端計算結果（JSON，不可竄改，只能引用與解釋）】\n${JSON.stringify(req.body.context)}`,
    });
  }

  let messages = [...systemMessages, ...turns];
  const toolTrace = [];

  try {
    let data = await callAzureChat(messages);
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
      data = await callAzureChat(messages);
    }

    const reply = data?.choices?.[0]?.message?.content;
    if (typeof reply !== "string") {
      return res.status(502).json({ error: "Azure OpenAI 回應格式異常。" });
    }
    res.json({ reply, tool_calls: toolTrace });
  } catch (err) {
    console.error("Chat handler failed", err, err.detail || "");
    if (err.status) return res.status(502).json({ error: err.message });
    res.status(500).json({ error: "後端呼叫 Azure OpenAI 時發生錯誤。" });
  }
});

app.listen(PORT, () => {
  console.log(`ResearchGap agent backend listening on :${PORT}`);
});
