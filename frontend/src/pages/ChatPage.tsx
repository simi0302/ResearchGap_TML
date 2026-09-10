import React, { useState, useRef, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { sendMessageToAgent, type Message } from "../lib/agent";

const GREETING: Message = {
  role: "assistant",
  content:
    "你好！我是 ResearchGap 專利白地分析助理。貼上你的研究成果，我可以幫你判讀能不能申請專利、以及旁邊還有哪些你沒注意到的可申請方向。",
};

export default function ChatPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const seedQuery = searchParams.get("q") ?? "";

  const [messages, setMessages] = useState<Message[]>([GREETING]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const seeded = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const send = async (text: string) => {
    if (!text.trim() || loading) return;
    const next = [...messages, { role: "user" as const, content: text.trim() }];
    setMessages(next);
    setInput("");
    setLoading(true);
    try {
      const reply = await sendMessageToAgent(text.trim(), next);
      setMessages((prev) => [...prev, { role: "assistant", content: reply }]);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (seedQuery && !seeded.current) {
      seeded.current = true;
      send(seedQuery);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedQuery]);

  // Only scroll once the message list actually grows — comparing lengths
  // (rather than a "have I run yet" flag) stays correct even when
  // React StrictMode replays this effect in dev.
  const lastScrolledCount = useRef(messages.length);
  useEffect(() => {
    if (messages.length !== lastScrolledCount.current) {
      lastScrolledCount.current = messages.length;
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, loading]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "calc(100vh - 128px)",
        maxWidth: 820,
        margin: "0 auto",
        background: "#ffffff",
        border: "1px solid #e2e8f0",
        borderRadius: 20,
        boxShadow: "0 20px 60px rgba(0,0,0,0.08), 0 4px 16px rgba(249,115,22,0.08)",
        overflow: "hidden",
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: "16px 20px",
          background: "var(--grad-hero)",
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <button
          onClick={() => navigate("/")}
          aria-label="返回"
          style={{
            width: 32, height: 32, borderRadius: 8, border: "none",
            background: "rgba(255,255,255,0.22)", color: "#fff",
            cursor: "pointer", fontSize: 16, display: "flex",
            alignItems: "center", justifyContent: "center",
          }}
        >
          ←
        </button>
        <div style={{
          width: 36, height: 36, borderRadius: 10,
          background: "rgba(255,255,255,0.2)",
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: 18,
        }}>✦</div>
        <div>
          <div style={{ fontWeight: 700, fontSize: 15, color: "#ffffff" }}>ResearchGap 專利白地分析助理</div>
          <div style={{ fontSize: 11, color: "rgba(255,255,255,0.85)" }}>SDN/NFV 專利白地分析</div>
        </div>
        <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#fde68a" }} />
          <span style={{ fontSize: 11, color: "rgba(255,255,255,0.9)" }}>Azure AI Foundry</span>
        </div>
      </div>

      {/* Messages */}
      <div style={{ flex: 1, overflowY: "auto", padding: "20px 20px 8px", background: "#fff9f2" }}>
        {messages.map((m, i) => (
          <div key={i} style={{
            marginBottom: 14,
            display: "flex",
            justifyContent: m.role === "user" ? "flex-end" : "flex-start",
          }}>
            {m.role === "assistant" && (
              <div style={{
                width: 28, height: 28, borderRadius: 8, flexShrink: 0, marginRight: 8, marginTop: 2,
                background: "var(--grad1)",
                display: "flex", alignItems: "center", justifyContent: "center",
                fontSize: 13, color: "#ffffff",
              }}>✦</div>
            )}
            <div style={{
              maxWidth: "78%", padding: "11px 15px",
              borderRadius: m.role === "user" ? "16px 16px 4px 16px" : "16px 16px 16px 4px",
              background: m.role === "user" ? "var(--grad1)" : "#ffffff",
              border: m.role === "user" ? "none" : "1px solid #fed7aa",
              color: m.role === "user" ? "#ffffff" : "#1e293b",
              fontSize: 14, lineHeight: 1.65,
              whiteSpace: "pre-wrap",
              boxShadow: "0 1px 3px rgba(0,0,0,0.06)",
            }}>
              {m.content}
            </div>
          </div>
        ))}
        {loading && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
            <div style={{
              width: 28, height: 28, borderRadius: 8,
              background: "var(--grad1)",
              display: "flex", alignItems: "center", justifyContent: "center",
              fontSize: 13, color: "#ffffff",
            }}>✦</div>
            <div style={{
              background: "#ffffff", border: "1px solid #fed7aa",
              borderRadius: "16px 16px 16px 4px", padding: "11px 15px",
              display: "flex", gap: 4, alignItems: "center",
            }}>
              {[0, 1, 2].map((i) => (
                <span key={i} style={{
                  width: 7, height: 7, borderRadius: "50%",
                  background: "var(--orange-500)", display: "block",
                  animation: `float 1s ease-in-out ${i * 0.15}s infinite`,
                }} />
              ))}
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div style={{
        padding: "14px 18px",
        borderTop: "1px solid #fed7aa",
        display: "flex", gap: 8, background: "#ffffff",
      }}>
        <input
          ref={inputRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(input); } }}
          placeholder="輸入問題…（Enter 送出）"
          style={{
            flex: 1, background: "#fff7ed", border: "1px solid #fed7aa",
            borderRadius: 12, padding: "11px 16px", color: "#1e293b",
            fontSize: 14, fontFamily: "'Inter', sans-serif", outline: "none",
            transition: "border-color 0.2s",
          }}
          onFocus={(e) => { e.target.style.borderColor = "var(--orange-500)"; e.target.style.background = "#ffffff"; }}
          onBlur={(e) => { e.target.style.borderColor = "#fed7aa"; e.target.style.background = "#fff7ed"; }}
        />
        <button
          onClick={() => send(input)}
          disabled={loading || !input.trim()}
          style={{
            width: 44, height: 44, borderRadius: 12, border: "none",
            background: loading || !input.trim() ? "#e2e8f0" : "var(--grad1)",
            color: loading || !input.trim() ? "#94a3b8" : "#ffffff",
            cursor: loading || !input.trim() ? "not-allowed" : "pointer",
            fontSize: 18, display: "flex", alignItems: "center", justifyContent: "center",
            transition: "all 0.2s",
            flexShrink: 0,
          }}
        >↑</button>
      </div>
    </div>
  );
}
