import React, { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import SearchBar from "../components/SearchBar";
import SiteNav from "../components/SiteNav";
import PatentDetailModal from "../components/PatentDetailModal";
import { toKpiStats } from "../data/sdnFixtures";
import type { PatentRecord } from "../types";

const HERO_SUGGESTIONS = ["SDN", "NFV", "Edge Computing", "6G Network", "AI Networking"];

interface PatentJsonRow {
  publication_number: string;
  title: string;
  abstract: string;
  jurisdiction: string;
  company_name: string;
  ipc: string[];
  cpc: string[];
  assignees: string[];
  publication_date: string;
  filing_date: string;
  category: string;
}

const PAGE_SIZE = 20;

function toPatentRecord(p: PatentJsonRow): PatentRecord {
  return {
    publication_number: p.publication_number,
    jurisdiction: p.jurisdiction as any,
    title: p.title,
    assignees: p.assignees?.length ? p.assignees : (p.company_name ? [p.company_name] : []),
    ipc: p.ipc ?? [],
    cpc: p.cpc ?? [],
    publication_date: p.publication_date || null,
    filing_date: p.filing_date || null,
    abstract: p.abstract || null,
    inventors: null,
    family_id: null,
  };
}

function StatBox({ value, label }: { value: string; label: string }) {
  return (
    <div className="stat-box-float" style={{
      textAlign: "center", padding: "16px 18px",
      background: "rgba(255,255,255,0.85)", borderRadius: 14,
      border: "1px solid rgba(254,215,170,0.9)",
      backdropFilter: "blur(10px)",
    }}>
      <div style={{ fontSize: 26, fontWeight: 800, color: "var(--orange-600)", fontFamily: "'Space Grotesk', sans-serif", lineHeight: 1 }}>
        {value}
      </div>
      <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 4, fontWeight: 500 }}>{label}</div>
    </div>
  );
}

export default function ExplorePage() {
  const kpi = useMemo(() => toKpiStats(), []);
  const navigate = useNavigate();

  const [allPatents, setAllPatents] = useState<PatentJsonRow[] | null>(null);
  const [query, setQuery] = useState("");
  const [jurisdiction, setJurisdiction] = useState("");
  const [yearStart, setYearStart] = useState("");
  const [yearEnd, setYearEnd] = useState("");
  const [showPatents, setShowPatents] = useState(true);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<PatentRecord | null>(null);

  useEffect(() => {
    fetch("/data/patents.json")
      .then((r) => r.json())
      .then((rows: PatentJsonRow[]) => setAllPatents(rows))
      .catch(() => setAllPatents([]));
  }, []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") setSelected(null); };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const filtered = useMemo(() => {
    if (!allPatents || !showPatents) return [];
    const q = query.trim().toLowerCase();
    const startYear = yearStart.trim() ? Number(yearStart) : null;
    const endYear = yearEnd.trim() ? Number(yearEnd) : null;
    return allPatents.filter((p) => {
      if (jurisdiction && p.jurisdiction !== jurisdiction) return false;
      const filingYear = p.filing_date ? Number(p.filing_date.slice(0, 4)) : null;
      if (startYear && (!filingYear || filingYear < startYear)) return false;
      if (endYear && (!filingYear || filingYear > endYear)) return false;
      if (!q) return true;
      return (
        p.title?.toLowerCase().includes(q) ||
        p.abstract?.toLowerCase().includes(q) ||
        p.company_name?.toLowerCase().includes(q) ||
        p.assignees?.some((a) => a.toLowerCase().includes(q))
      );
    });
  }, [allPatents, query, jurisdiction, yearStart, yearEnd, showPatents]);

  useEffect(() => setPage(1), [query, jurisdiction, yearStart, yearEnd, showPatents]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const pageRows = filtered.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  const jurisdictions = useMemo(() => {
    if (!allPatents) return [];
    return Array.from(new Set(allPatents.map((p) => p.jurisdiction))).sort();
  }, [allPatents]);

  return (
    <div>
      {/* Hero — matches the Week21 design mockup: full-bleed gradient, transparent nav, left-aligned title */}
      <div className="hero-bleed">
        <div className="hero-bleed__inner">
          <SiteNav variant="transparent" />

          <h1 className="hero-bleed__title">ResearchGap</h1>
          <p className="hero-bleed__subtitle">專利文獻白地分析平台</p>

          <div className="hero-columns">
            <div className="hero-columns__search">
              <div style={{ maxWidth: 640 }}>
                <SearchBar size="hero" autoFocus />
              </div>

              <div className="hero-suggestions">
                <span className="hero-suggestions__label">You can try:</span>
                {HERO_SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    className="hero-suggestions__pill"
                    onClick={() => navigate(`/chat?q=${encodeURIComponent(s)}`)}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>

            <div className="hero-columns__filters">
              <div className="hero-filters__row">
                <div className="hero-filters__group">
                  <span className="hero-filters__label">Year Start</span>
                  <input
                    className="hero-filters__year-input"
                    value={yearStart}
                    onChange={(e) => setYearStart(e.target.value.replace(/\D/g, "").slice(0, 4))}
                    placeholder="YYYY"
                    inputMode="numeric"
                  />
                </div>

                <span className="hero-filters__dash" style={{ marginBottom: 10 }}>–</span>

                <div className="hero-filters__group">
                  <span className="hero-filters__label">Year End</span>
                  <input
                    className="hero-filters__year-input"
                    value={yearEnd}
                    onChange={(e) => setYearEnd(e.target.value.replace(/\D/g, "").slice(0, 4))}
                    placeholder="YYYY"
                    inputMode="numeric"
                  />
                </div>
              </div>

              <div className="hero-filters__group">
                <span className="hero-filters__label">Country</span>
                <select
                  className="hero-filters__select"
                  value={jurisdiction}
                  onChange={(e) => setJurisdiction(e.target.value)}
                >
                  <option value="">全部</option>
                  {jurisdictions.map((j) => <option key={j} value={j}>{j}</option>)}
                </select>
              </div>

              <div className="hero-filters__group">
                <span className="hero-filters__label">Type</span>
                <div className="hero-filters__types">
                  <label className="hero-filters__checkbox">
                    <input type="checkbox" checked={showPatents} onChange={(e) => setShowPatents(e.target.checked)} />
                    Patent
                  </label>
                  <label className="hero-filters__checkbox is-disabled" title="尚無論文檢索資料，開放時間待補">
                    <input type="checkbox" checked={false} disabled readOnly />
                    Academic Paper<span className="hero-filters__soon">（尚無資料）</span>
                  </label>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* KPI row */}
      <div style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
        gap: 14,
        marginTop: 32,
        marginBottom: 32,
      }}>
        <StatBox value={kpi.total.toLocaleString()} label="SDN/NFV 有效專利總數" />
        <StatBox value={String(kpi.jurisdictionCount)} label="涵蓋管轄局" />
        <StatBox value={String(kpi.coreAgenticAi)} label="核心代理型 AI" />
        <StatBox value={String(kpi.aiOrchestration)} label="AI 關聯編排" />
        <StatBox value={String(kpi.twCount)} label="台灣（TW）" />
        <StatBox value={String(kpi.sourceCountryCount)} label="申請人來源國" />
      </div>

      {/* Browse patents */}
      <div className="filter-glass" style={{ padding: 20, marginBottom: 16 }}>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜尋標題、摘要、申請人…"
          style={{ width: "100%", padding: "9px 14px", fontSize: 14, border: "1.5px solid #e2e8f0", borderRadius: 8, outline: "none" }}
          onFocus={(e) => (e.target.style.borderColor = "var(--orange-500)")}
          onBlur={(e) => (e.target.style.borderColor = "#e2e8f0")}
        />
      </div>

      <div className="chart-card-v2 patents-results-card" style={{ padding: 0 }}>
        {allPatents === null ? (
          <div style={{ padding: 60, textAlign: "center", color: "#94a3b8" }}>載入中…</div>
        ) : pageRows.length === 0 ? (
          <div style={{ padding: 60, textAlign: "center", color: "#94a3b8" }}>查無符合條件的專利</div>
        ) : (
          <>
            <div className="patents-table-wrap">
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ background: "#fff7ed", borderBottom: "1px solid #fed7aa" }}>
                    {["公開號", "標題", "申請人", "管轄局", "申請日"].map((h) => (
                      <th key={h} style={{ padding: "12px 16px", textAlign: "left", fontWeight: 600, color: "#9a3412", fontSize: 12, textTransform: "uppercase", letterSpacing: "0.05em" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((p) => (
                    <tr
                      key={p.publication_number}
                      onClick={() => setSelected(toPatentRecord(p))}
                      style={{ borderBottom: "1px solid #f1f5f9", cursor: "pointer" }}
                      onMouseEnter={(e) => (e.currentTarget.style.background = "#fff7ed")}
                      onMouseLeave={(e) => (e.currentTarget.style.background = "")}
                    >
                      <td style={{ padding: "12px 16px", color: "var(--orange-600)", fontFamily: "monospace", fontSize: 12, whiteSpace: "nowrap" }}>{p.publication_number}</td>
                      <td style={{ padding: "12px 16px", color: "#1e293b", lineHeight: 1.4, maxWidth: 360 }}>{p.title}</td>
                      <td style={{ padding: "12px 16px", color: "#475569", maxWidth: 200 }}>{(p.assignees?.length ? p.assignees : [p.company_name]).slice(0, 2).join(", ")}</td>
                      <td style={{ padding: "12px 16px" }}>
                        <span style={{ background: "#ffedd5", color: "var(--orange-600)", fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 6 }}>{p.jurisdiction}</span>
                      </td>
                      <td style={{ padding: "12px 16px", color: "#94a3b8", whiteSpace: "nowrap" }}>{p.filing_date || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div style={{ padding: "14px 24px", borderTop: "1px solid #f1f5f9", display: "flex", alignItems: "center", justifyContent: "space-between", background: "#fff7ed" }}>
              <span style={{ fontSize: 13, color: "#64748b" }}>
                第 {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, filtered.length)} 筆，共 {filtered.length.toLocaleString()} 筆
              </span>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1} style={pageBtn(page === 1)}>‹</button>
                <span style={{ fontSize: 13, color: "#64748b", padding: "0 6px" }}>{page} / {totalPages}</span>
                <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page === totalPages} style={pageBtn(page === totalPages)}>›</button>
              </div>
            </div>
          </>
        )}
      </div>

      <PatentDetailModal patent={selected} onClose={() => setSelected(null)} />
    </div>
  );
}

function pageBtn(disabled: boolean): React.CSSProperties {
  return {
    minWidth: 32, height: 32, borderRadius: 8,
    background: disabled ? "transparent" : "#ffffff",
    color: disabled ? "#cbd5e1" : "#475569",
    fontSize: 13,
    cursor: disabled ? "not-allowed" : "pointer",
    border: "1px solid #e2e8f0",
  };
}
