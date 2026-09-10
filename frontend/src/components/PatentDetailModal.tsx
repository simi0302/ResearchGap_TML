import React from "react";
import type { PatentRecord } from "../types";
import { getPatentClassificationTitleZh } from "../utils/classificationLabels";

interface PatentDetailModalProps {
  patent: PatentRecord | null;
  loading?: boolean;
  onClose: () => void;
}

const JURISDICTION_LABELS: Record<string, string> = {
  TW: "台灣", US: "美國", EP: "歐洲", JP: "日本",
  SG: "新加坡", TH: "泰國", VN: "越南", MY: "馬來西亞",
};

const JURISDICTION_COLORS: Record<string, { bg: string; color: string; border: string }> = {
  TW: { bg: "rgba(254,249,195,0.95)", color: "#854d0e", border: "rgba(253,224,71,0.9)" },
  US: { bg: "rgba(219,234,254,0.95)", color: "#1e40af", border: "rgba(147,197,253,0.95)" },
  EP: { bg: "rgba(220,252,231,0.95)", color: "#166534", border: "rgba(134,239,172,0.9)" },
  JP: { bg: "rgba(252,231,243,0.95)", color: "#9d174d", border: "rgba(249,168,212,0.85)" },
  SG: { bg: "rgba(255,237,213,0.95)", color: "#9a3412", border: "rgba(253,186,116,0.9)" },
  TH: { bg: "rgba(237,233,254,0.95)", color: "#5b21b6", border: "rgba(196,181,253,0.9)" },
  VN: { bg: "rgba(254,242,242,0.95)", color: "#991b1b", border: "rgba(252,165,165,0.85)" },
  MY: { bg: "rgba(236,253,245,0.95)", color: "#065f46", border: "rgba(110,231,183,0.85)" },
};

function googlePatentsUrl(pub: string) {
  return `https://patents.google.com/patent/${pub.replace(/[/ ]/g, "")}`;
}

function ClassificationPill({
  code,
  color = "var(--orange-600)",
  bg = "rgba(255,237,213,0.9)",
  border = "rgba(253,186,116,0.95)",
}: {
  code: string;
  color?: string;
  bg?: string;
  border?: string;
}) {
  const zh = getPatentClassificationTitleZh(code);
  return (
    <span
      style={{
        display: "inline-flex",
        flexDirection: "column",
        alignItems: "flex-start",
        padding: "6px 12px 7px",
        borderRadius: 10,
        fontSize: 12,
        fontWeight: 600,
        color,
        background: bg,
        border: `1px solid ${border}`,
        marginRight: 8,
        marginBottom: 8,
        maxWidth: "100%",
      }}
    >
      <span style={{ fontFamily: "ui-monospace, Consolas, monospace", letterSpacing: "0.02em" }}>{code}</span>
      {zh && (
        <span style={{ fontSize: 10, fontWeight: 500, color: "#64748b", marginTop: 4, lineHeight: 1.4, whiteSpace: "normal" }}>
          {zh}
        </span>
      )}
    </span>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 22 }}>
      <div style={{
        fontSize: 11, fontWeight: 700, color: "#64748b",
        letterSpacing: "0.06em", marginBottom: 10,
      }}>
        {title}
      </div>
      {children}
    </div>
  );
}

export default function PatentDetailModal({ patent, loading = false, onClose }: PatentDetailModalProps) {
  if (!patent) return null;

  const jurStyle = JURISDICTION_COLORS[patent.jurisdiction] ?? { bg: "#f1f5f9", color: "#475569", border: "#e2e8f0" };

  const metaCore: { label: string; value: string; mono?: boolean }[] = [
    { label: "公開號", value: patent.publication_number, mono: true },
    { label: "申請日", value: patent.filing_date ?? "—" },
    { label: "公告日", value: patent.publication_date ?? "—" },
  ];
  const familyTrim = (patent.family_id ?? "").trim();
  if (familyTrim) {
    metaCore.push({ label: "同族編號", value: familyTrim, mono: true });
  }

  return (
    <div
      className="modal-backdrop-v2"
      onClick={onClose}
      style={{
        position: "fixed", inset: 0,
        display: "flex", alignItems: "center", justifyContent: "center",
        zIndex: 1000, padding: "24px 16px",
      }}
    >
      <div
        className="modal-panel-v2"
        onClick={e => e.stopPropagation()}
        style={{
          borderRadius: 20,
          padding: 0,
          maxWidth: 800,
          width: "100%",
          maxHeight: "min(92vh, 900px)",
          overflow: "hidden",
          position: "relative",
          display: "flex",
          flexDirection: "column",
          animation: "appear 0.22s ease-out",
        }}
      >
        <div
          aria-hidden
          style={{
            position: "absolute", top: 0, left: 0, right: 0, height: 3,
            borderRadius: "20px 20px 0 0",
            background: "linear-gradient(90deg, #f97316, #ea580c, #f59e0b, #fb923c)",
            opacity: 0.95,
          }}
        />

        {/* Header */}
        <div style={{
          padding: "22px 26px 18px",
          borderBottom: "1px solid rgba(226,232,240,0.85)",
          position: "sticky",
          top: 0,
          zIndex: 2,
          background: "linear-gradient(180deg, rgba(255,255,255,0.98) 0%, rgba(248,250,252,0.96) 100%)",
          borderRadius: "20px 20px 0 0",
        }}>
          <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 14 }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
                <span style={{
                  padding: "4px 12px", borderRadius: 999, fontSize: 12, fontWeight: 700,
                  background: jurStyle.bg, color: jurStyle.color, border: `1px solid ${jurStyle.border}`,
                }}>
                  {patent.jurisdiction} · {JURISDICTION_LABELS[patent.jurisdiction] ?? patent.jurisdiction}
                </span>
                {loading && (
                  <span style={{ fontSize: 12, color: "#64748b", display: "inline-flex", alignItems: "center", gap: 5 }}>
                    <span style={{ animation: "spin 1s linear infinite", display: "inline-block" }}>◌</span>
                    載入完整資料…
                  </span>
                )}
              </div>
              <h2 style={{
                margin: 0,
                color: "#0f172a",
                fontSize: 17,
                fontWeight: 600,
                fontFamily: "'Space Grotesk', 'Inter', sans-serif",
                lineHeight: 1.45,
                letterSpacing: "-0.015em",
              }}>
                {patent.title}
              </h2>
            </div>
            <button
              type="button"
              aria-label="關閉"
              onClick={onClose}
              style={{
                flexShrink: 0,
                background: "rgba(241,245,249,0.95)",
                border: "1px solid #e2e8f0",
                borderRadius: 999,
                width: 38,
                height: 38,
                fontSize: 18,
                lineHeight: 1,
                cursor: "pointer",
                color: "#64748b",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                transition: "background 0.15s, color 0.15s, border-color 0.15s",
              }}
              onMouseEnter={e => {
                e.currentTarget.style.background = "#ffedd5";
                e.currentTarget.style.color = "var(--orange-600)";
                e.currentTarget.style.borderColor = "#fdba74";
              }}
              onMouseLeave={e => {
                e.currentTarget.style.background = "rgba(241,245,249,0.95)";
                e.currentTarget.style.color = "#64748b";
                e.currentTarget.style.borderColor = "#e2e8f0";
              }}
            >
              ×
            </button>
          </div>
        </div>

        {/* Body */}
        <div style={{
          padding: "22px 26px 26px",
          overflowY: "auto",
          flex: 1,
          minHeight: 0,
          background: "linear-gradient(180deg, rgba(255,255,255,0.5) 0%, rgba(248,250,252,0.55) 100%)",
        }}>

          <div style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
            gap: "14px 20px",
            marginBottom: 22,
            background: "rgba(255,255,255,0.72)",
            borderRadius: 14,
            padding: "18px 20px",
            border: "1px solid rgba(226,232,240,0.9)",
            boxShadow: "0 1px 0 rgba(255,255,255,0.9) inset",
          }}>
            {metaCore.map(({ label, value, mono }) => (
              <div key={label}>
                <div style={{
                  fontSize: 11, fontWeight: 700, color: "#94a3b8",
                  letterSpacing: "0.06em", marginBottom: 5,
                }}>
                  {label}
                </div>
                <div style={{
                  fontSize: 14,
                  color: "#0f172a",
                  fontFamily: mono ? "ui-monospace, Consolas, monospace" : "inherit",
                  lineHeight: 1.4,
                  wordBreak: mono ? "break-all" : "normal",
                }}>
                  {value}
                </div>
              </div>
            ))}
          </div>
          {!familyTrim && (
            <p style={{ margin: "-8px 0 20px", fontSize: 12, color: "#94a3b8", lineHeight: 1.5 }}>
              同族編號未收錄於資料庫（蒐集來源未提供時不顯示）。
            </p>
          )}

          {patent.assignees?.length > 0 && (
            <Section title="申請人">
              <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                {patent.assignees.map(a => (
                  <span key={a} style={{
                    padding: "6px 14px", borderRadius: 999, fontSize: 13, fontWeight: 500,
                    background: "rgba(241,245,249,0.95)", color: "#334155",
                    border: "1px solid #e2e8f0",
                  }}>{a}</span>
                ))}
              </div>
            </Section>
          )}

          {patent.inventors && patent.inventors.length > 0 && (
            <Section title="發明人">
              <div style={{ fontSize: 14, color: "#475569", lineHeight: 1.75 }}>
                {patent.inventors.join("　·　")}
              </div>
            </Section>
          )}

          {patent.ipc?.length > 0 && (
            <Section title="IPC 分類">
              <div style={{ display: "flex", flexWrap: "wrap" }}>{patent.ipc.map(c => <ClassificationPill key={c} code={c} />)}</div>
            </Section>
          )}

          {patent.cpc?.length > 0 && (
            <Section title="CPC 分類">
              <div style={{ display: "flex", flexWrap: "wrap" }}>
                {patent.cpc.map(c => (
                  <ClassificationPill key={c} code={c} color="#047857" bg="rgba(240,253,244,0.95)" border="rgba(134,239,172,0.9)" />
                ))}
              </div>
            </Section>
          )}

          {patent.abstract ? (
            <Section title="摘要">
              <p style={{
                margin: 0, lineHeight: 1.85, color: "#334155", fontSize: 14,
                background: "rgba(255,255,255,0.75)", borderRadius: 12, padding: "16px 18px",
                border: "1px solid rgba(226,232,240,0.85)", whiteSpace: "pre-wrap",
              }}>{patent.abstract}</p>
            </Section>
          ) : (
            <Section title="摘要">
              <p style={{ margin: 0, color: "#94a3b8", fontSize: 14, fontStyle: "italic" }}>無摘要資料</p>
            </Section>
          )}

          <div style={{
            display: "flex", flexWrap: "wrap", gap: 10, marginTop: 4, paddingTop: 18,
            borderTop: "1px solid rgba(226,232,240,0.85)",
          }}>
            <a
              href={googlePatentsUrl(patent.publication_number)}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                padding: "10px 18px", borderRadius: 10, fontSize: 13, fontWeight: 600,
                background: "var(--grad1)", color: "#fff",
                textDecoration: "none",
                boxShadow: "0 4px 14px rgba(249,115,22,0.28)",
                transition: "opacity 0.15s, transform 0.15s",
              }}
              onMouseEnter={e => { e.currentTarget.style.opacity = "0.92"; e.currentTarget.style.transform = "translateY(-1px)"; }}
              onMouseLeave={e => { e.currentTarget.style.opacity = "1"; e.currentTarget.style.transform = "none"; }}
            >
              Google Patents
              <span style={{ opacity: 0.9, fontSize: 12 }}>↗</span>
            </a>
            <a
              href={`https://worldwide.espacenet.com/patent/search?q=${encodeURIComponent(patent.publication_number)}`}
              target="_blank"
              rel="noopener noreferrer"
              style={{
                display: "inline-flex", alignItems: "center", gap: 6,
                padding: "10px 18px", borderRadius: 10, fontSize: 13, fontWeight: 600,
                background: "rgba(255,255,255,0.9)", color: "#334155",
                textDecoration: "none", border: "1px solid #e2e8f0",
                transition: "border-color 0.15s, color 0.15s",
              }}
              onMouseEnter={e => { e.currentTarget.style.borderColor = "var(--orange-300)"; e.currentTarget.style.color = "var(--orange-600)"; }}
              onMouseLeave={e => { e.currentTarget.style.borderColor = "#e2e8f0"; e.currentTarget.style.color = "#334155"; }}
            >
              Espacenet
              <span style={{ opacity: 0.75, fontSize: 12 }}>↗</span>
            </a>
          </div>
        </div>
      </div>
    </div>
  );
}
