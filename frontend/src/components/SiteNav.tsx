import React, { useState } from "react";
import { Link, useLocation } from "react-router-dom";

export const navLinks = [
  { to: "/", label: "EXPLORE" },
  { to: "/white-space", label: "WHITE SPACE" },
  { to: "/trends", label: "TRENDS" },
  { to: "/chat", label: "AI ASSISTANT" },
];

interface SiteNavProps {
  /** transparent: white text over the orange hero. solid: dark text on a glass bar. */
  variant: "transparent" | "solid";
}

export default function SiteNav({ variant }: SiteNavProps) {
  const { pathname } = useLocation();
  const [hovered, setHovered] = useState<string | null>(null);
  const isTransparent = variant === "transparent";

  return (
    <div style={{
      padding: isTransparent ? "0" : "0 32px",
      minHeight: isTransparent ? "auto" : 64,
      display: "flex", alignItems: "center", justifyContent: "space-between",
      flexWrap: "wrap", gap: "12px 16px",
    }}>
      <Link to="/" style={{ display: "flex", alignItems: "center", textDecoration: "none" }}>
        <img
          src="/logo.png"
          alt="ResearchGap"
          style={{ height: isTransparent ? 58 : 46, width: "auto", borderRadius: 8 }}
        />
      </Link>

      <div style={{ display: "flex", flexWrap: "wrap", gap: isTransparent ? 8 : 6 }}>
        {navLinks.map(({ to, label }) => {
          const active = pathname === to;
          const isHov = hovered === to;
          return (
            <Link
              key={to}
              to={to}
              className="nav-link-fancy"
              onMouseEnter={() => setHovered(to)}
              onMouseLeave={() => setHovered(null)}
              style={{
                display: "flex", alignItems: "center",
                padding: "10px 18px", borderRadius: 10,
                fontSize: 13, fontWeight: 700, letterSpacing: "0.08em",
                background: isTransparent
                  ? (active || isHov ? "rgba(255,255,255,0.16)" : "transparent")
                  : (active ? "rgba(255,237,213,0.95)" : isHov ? "rgba(255,247,237,0.9)" : "transparent"),
                color: isTransparent
                  ? "#ffffff"
                  : (active ? "var(--orange-600)" : isHov ? "#1e293b" : "#64748b"),
              }}
            >
              {label}
            </Link>
          );
        })}
      </div>
    </div>
  );
}
