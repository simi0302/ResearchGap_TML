import React, { useState } from "react";
import { useNavigate } from "react-router-dom";

interface SearchBarProps {
  size?: "hero" | "compact";
  placeholder?: string;
  autoFocus?: boolean;
}

export default function SearchBar({
  size = "hero",
  placeholder = "請輸入技術、研究領域或關鍵字",
  autoFocus = false,
}: SearchBarProps) {
  const [input, setInput] = useState("");
  const [focused, setFocused] = useState(false);
  const navigate = useNavigate();

  const isHero = size === "hero";

  const submit = (value?: string) => {
    const text = (value ?? input).trim();
    if (!text) return;
    navigate(`/chat?q=${encodeURIComponent(text)}`);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") submit();
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        background: "#ffffff",
        border: `2px solid ${focused ? "var(--orange-500)" : "transparent"}`,
        borderRadius: 999,
        padding: isHero ? "6px 6px 6px 28px" : "4px 4px 4px 16px",
        transition: "border-color 0.2s ease, box-shadow 0.2s ease",
        boxShadow: focused
          ? "0 0 0 4px rgba(255,255,255,0.35)"
          : "0 4px 20px rgba(154,52,18,0.18)",
      }}
    >
      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        placeholder={placeholder}
        autoFocus={autoFocus}
        style={{
          flex: 1,
          background: "transparent",
          border: "none",
          outline: "none",
          color: "#7c2d12",
          fontSize: isHero ? 16 : 14,
          fontFamily: "'Inter', sans-serif",
          padding: isHero ? "14px 0" : "8px 0",
          minWidth: 0,
        }}
      />

      <button
        onClick={() => submit()}
        aria-label="搜尋"
        style={{
          width: isHero ? 50 : 36,
          height: isHero ? 50 : 36,
          borderRadius: "50%",
          border: "none",
          flexShrink: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: isHero ? 20 : 15,
          cursor: "pointer",
          background: "var(--orange-600)",
          color: "#ffffff",
          boxShadow: "0 4px 14px rgba(154,52,18,0.35)",
          transition: "all 0.2s ease",
        }}
      >
        ⌕
      </button>
    </div>
  );
}
