import React, { useMemo } from "react";
import YearlyTrendChart from "../components/YearlyTrendChart";
import CountryDistributionChart from "../components/CountryDistributionChart";
import AssigneeRankingChart from "../components/AssigneeRankingChart";
import {
  toYearlyTrendData,
  toCountryDistributionData,
  toAssigneeRankingData,
  toTwDeepDive,
} from "../data/sdnFixtures";

function Card({ children, title, accent = "var(--orange-500)", span2 = false }: {
  children: React.ReactNode; title: string; accent?: string; span2?: boolean;
}) {
  return (
    <div className="chart-card-v2" style={{ gridColumn: span2 ? "span 2" : "span 1" }}>
      <div style={{
        fontSize: 15, fontWeight: 700, marginBottom: 18, color: "#1e293b",
        fontFamily: "'Space Grotesk', sans-serif",
        display: "flex", alignItems: "center", gap: 10,
      }}>
        <span style={{
          display: "inline-block", width: 4, height: 18, borderRadius: 2,
          background: accent, boxShadow: `0 0 14px ${accent}55`,
        }} />
        {title}
      </div>
      {children}
    </div>
  );
}

export default function TrendsPage() {
  const yearly = useMemo(() => toYearlyTrendData(), []);
  const country = useMemo(() => toCountryDistributionData(), []);
  const assignee = useMemo(() => toAssigneeRankingData(), []);
  const tw = useMemo(() => toTwDeepDive(), []);

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{
          fontFamily: "'Space Grotesk', sans-serif", fontSize: 28, fontWeight: 800, margin: "0 0 8px", color: "#0f172a",
          letterSpacing: "-0.02em",
        }}>
          TRENDS
        </h1>
        <p style={{ color: "#64748b", fontSize: 14 }}>SDN/NFV 專利申請趨勢、地區分佈與申請人排名</p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 20, marginBottom: 20 }}>
        <Card title={`公開專利累積趨勢（${yearly.years[0]}–${yearly.years[yearly.years.length - 1]}）`} span2>
          <YearlyTrendChart data={yearly} />
        </Card>

        <Card title="申請人 × 管轄局分佈" span2>
          <CountryDistributionChart data={country} />
        </Card>

        <Card title="申請人排名" span2>
          <AssigneeRankingChart data={assignee} />
        </Card>
      </div>

      <Card title="台灣（TW）深度解析" span2>
        <div className="tw-deep-dive-grid">
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#94a3b8", letterSpacing: "0.06em", marginBottom: 10 }}>
              TW 申請人來源地區
            </div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <tbody>
                {tw.byRegion.map((r) => (
                  <tr key={r.region} style={{ borderBottom: "1px solid #f1f5f9" }}>
                    <td style={{ padding: "6px 8px", color: "#334155" }}>{r.region}</td>
                    <td style={{ padding: "6px 8px", textAlign: "right", color: "var(--orange-600)", fontWeight: 700 }}>{r.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div>
            <div style={{ fontSize: 12, fontWeight: 700, color: "#94a3b8", letterSpacing: "0.06em", marginBottom: 10 }}>
              TW 相關申請人明細
            </div>
            <div style={{ maxHeight: 320, overflowY: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ background: "#fff7ed" }}>
                    <th style={{ padding: "6px 8px", textAlign: "left", color: "#9a3412", fontSize: 11 }}>地區</th>
                    <th style={{ padding: "6px 8px", textAlign: "left", color: "#9a3412", fontSize: 11 }}>申請人</th>
                    <th style={{ padding: "6px 8px", textAlign: "right", color: "#9a3412", fontSize: 11 }}>件數</th>
                  </tr>
                </thead>
                <tbody>
                  {tw.byCompany.map((r, i) => (
                    <tr key={`${r.company}-${i}`} style={{ borderBottom: "1px solid #f1f5f9" }}>
                      <td style={{ padding: "6px 8px", color: "#64748b" }}>{r.region}</td>
                      <td style={{ padding: "6px 8px", color: "#334155" }}>{r.company}</td>
                      <td style={{ padding: "6px 8px", textAlign: "right", color: "#1e293b" }}>{r.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
}
