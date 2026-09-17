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

  // Per-turn table steering: gpt-4.1-mini reliably follows the systemPrompt's Stage
  // rules right after a tool call, but on a *second* question in the same conversation
  // (e.g. "現在看白地" right after a POS question) it was observed just re-pasting the
  // previous turn's Stage 1 table instead of switching to Stage 3 — the systemPrompt's
  // static Stage-selection rule sits too far from the end of the context for a small
  // model to reliably re-apply every turn. Detect the latest user turn's intent with a
  // keyword check (deterministic, not model-guessed) and re-append a short reminder as
  // the LAST message before every model call in this request (see buildCallMessages
  // below) so it's always the freshest instruction, even across tool-calling rounds.
  const latestUserContent = [...turns].reverse().find((t) => t.role === "user")?.content || "";
  const wantsWhitespace = /白地|white[\s-]?space|機會缺口|技術組合/i.test(latestUserContent);
  const wantsPOS = /勝率|可專利性|patentability|POS\b|機會分數/i.test(latestUserContent);
  let steeringMessage = null;
  if (wantsWhitespace && !wantsPOS) {
    steeringMessage = {
      role: "system",
      content: "【本輪強制指令】使用者這則訊息問的是白地／技術組合分析。這一輪回覆只能輸出 Stage 3 的「技術組合白地表」，直接引用 compute_patentability 結果的 combination_whitespace 陣列逐列照抄。嚴禁這一輪輸出 Stage 1 的 POS 子分數表，也不可把先前對話已回答過的 POS 表格再貼一次。",
    };
  } else if (wantsPOS && !wantsWhitespace) {
    steeringMessage = {
      role: "system",
      content: "【本輪強制指令】使用者這則訊息問的是 POS／勝率分析。這一輪回覆只能輸出 Stage 1 的「子分數表」，直接引用 compute_patentability 結果的 breakdown 陣列逐列照抄。",
    };
  }
  const buildCallMessages = (base) => (steeringMessage ? [...base, steeringMessage] : base);

  // Hard guarantee, not just a prompt hint: gpt-4.1-mini was observed (reproducibly,
  // even single-turn) ignoring an explicit white-space question and re-answering with
  // the Stage 1 POS table instead of Stage 3's technology-combination table — a prompt
  // is a request, not a contract, and this project's "AI 只負責解釋，backend 決定數字"
  // rule means the table itself shouldn't depend on the model getting the format right.
  // So for white-space specifically, the reply is replaced with a deterministically
  // rendered table straight from the same JSON the model sees (see below, near the
  // final reply assembly) rather than trusted to the model's own formatting.
  function escapeMd(v) {
    return String(v ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
  }
  function statusLabel(status) {
    if (status === "gap") return "Potential White Space 潛在白地";
    if (status === "crowded") return "Crowded 高密度";
    return "Developing 發展中";
  }
  function renderWhitespaceTable(rows) {
    const body = rows.map(
      (r) =>
        `| ${escapeMd(r.combo_a)} (${r.ipc_a}) × ${escapeMd(r.combo_b)} (${r.ipc_b}) | ${r.count} | ${statusLabel(r.status)} | ${escapeMd(r.evidence_zh || r.evidence_en)} |`
    );
    return [
      "| 技術組合 / Combination | 母體內專利數 / Patents | 狀態 / Status | 佐證 / Evidence |",
      "|---|---|---|---|",
      ...body,
    ].join("\n");
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

    const reply = data?.choices?.[0]?.message?.content;
    if (typeof reply !== "string") {
      return res.status(502).json({ error: "Azure OpenAI 回應格式異常。" });
    }

    // See the "Hard guarantee" block above buildCallMessages. Only the white-space case
    // gets a deterministic *replacement* (not just a prepend) — repeated local testing
    // showed gpt-4.1-mini reliably re-answers with the Stage 1 POS table instead of the
    // Stage 3 white-space table even on a single-turn, unambiguous "白地分析" question,
    // so the model's own text for that case is actively wrong, not just incomplete, and
    // showing it underneath would just contradict the real table above it. The POS case
    // (wantsPOS) was verified working correctly on its own in the same testing, so it's
    // left alone rather than risking a duplicated table for the common case.
    let finalReply = reply;
    if (wantsWhitespace && !wantsPOS) {
      const lastScored = [...toolTrace]
        .reverse()
        .find((t) => t.tool === "compute_patentability" && t.result && !t.result.needs_confirmation && t.result.score !== undefined);
      if (lastScored) {
        const r = lastScored.result;
        const rows = Array.isArray(r.combination_whitespace) ? r.combination_whitespace : [];
        const table = rows.length
          ? `以 ${r.cutoff_year} 年為基準日，共找到 ${rows.filter((x) => x.status === "gap").length} 個技術組合白地（技術分類：${r.subtech_label}）。\n\n${renderWhitespaceTable(rows)}\n\n資料來源：ResearchGap 後端計算，N=2,799，資料擷取自 GPSS。`
          : `以 ${r.cutoff_year} 年為基準日，此案例的技術分類（${r.subtech_label}）不在已知技術分組內，暫無可呈現的技術組合白地表格。`;
        // Keep the model's own text as supplementary content (web-sourced evidence,
        // suggested jurisdictions, attorney questions) only if it actually stayed on
        // topic — if it leaked Stage 1's POS/sub-score vocabulary, it's the wrong-topic
        // answer this override exists to fix, so drop it instead of showing it under a
        // table that already contradicts it.
        const leakedWrongTopic = /Novelty|新穎性|Crowding|擁擠度|Temporal 時間差/i.test(reply);
        finalReply = leakedWrongTopic ? table : `${table}\n\n---\n\n${reply}`;
      }
    }

    // Real token usage as reported by Azure OpenAI for this turn (summed across every
    // tool-calling round it took) — not estimated, so the UI can show real cost, not a guess.
    res.json({ reply: finalReply, tool_calls: toolTrace, usage: usageTotal });
  } catch (err) {
    console.error("Chat handler failed", err, err.detail || "");
    if (err.status) return res.status(502).json({ error: err.message });
    res.status(500).json({ error: "後端呼叫 Azure OpenAI 時發生錯誤。" });
  }
});

app.listen(PORT, () => {
  console.log(`ResearchGap agent backend listening on :${PORT}`);
});
