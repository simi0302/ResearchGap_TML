/**
 * Integration seam for the real conversational agent.
 *
 * The real agent runs on Azure AI Foundry (Foundry Agent Service / Azure OpenAI
 * in Foundry Models), fronted by a small Azure App Service backend the team is
 * deploying separately (see ../../BACKEND.md at the repo root once it exists).
 * This function POSTs to that backend's HTTP endpoint — set its URL via the
 * VITE_AGENT_API_URL env var (see .env.example). Until that backend is live,
 * it returns an honest "not deployed yet" message instead of inventing a reply.
 */

const AGENT_API_URL = import.meta.env.VITE_AGENT_API_URL as string | undefined;

export interface Message {
  role: "user" | "assistant";
  content: string;
}

export async function sendMessageToAgent(
  message: string,
  history: Message[],
): Promise<string> {
  if (!AGENT_API_URL) {
    return "AI 助理後端尚未部署（VITE_AGENT_API_URL 未設定）。這個訊息不是助理的回覆，只是提醒開發中的狀態——後端上線後這裡會換成真正的分析結果。";
  }

  try {
    const res = await fetch(AGENT_API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message, history }),
    });
    if (!res.ok) {
      return `助理暫時無法回應（伺服器回傳 ${res.status}）。請稍後再試，或聯絡系統管理員確認後端服務狀態。`;
    }
    const data = await res.json();
    if (typeof data?.reply !== "string") {
      return "助理回應格式異常，請聯絡系統管理員確認後端服務。";
    }
    return data.reply;
  } catch {
    return "無法連線到助理後端，請確認網路連線，或稍後再試。";
  }
}
