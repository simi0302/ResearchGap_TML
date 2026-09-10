import React, { useMemo } from "react";
import TechCountryHeatmap from "../components/TechCountryHeatmap";
import { toAgenticCategoryMatrix } from "../data/sdnFixtures";
import type { WhiteSpacePair } from "../types";

export default function WhiteSpacePage() {
  const matrix = useMemo(() => toAgenticCategoryMatrix(), []);

  // Cells with zero filed patents are the real, sourced whitespace signal here —
  // no paper-count data exists yet to build a full patent-vs-paper quadrant.
  const whiteSpacePairs = useMemo<WhiteSpacePair[]>(() => {
    const pairs: WhiteSpacePair[] = [];
    matrix.row_labels.forEach((tech, r) => {
      matrix.col_labels.forEach((country, c) => {
        if ((matrix.values[r]?.[c] ?? 0) === 0) {
          pairs.push({ tech, country, global_growth: 0, local_share: 0 });
        }
      });
    });
    return pairs;
  }, [matrix]);

  return (
    <div>
      <div style={{ marginBottom: 24 }}>
        <h1 style={{
          fontFamily: "'Space Grotesk', sans-serif", fontSize: 28, fontWeight: 800, margin: "0 0 8px", color: "#0f172a",
          letterSpacing: "-0.02em",
        }}>
          WHITE SPACE
        </h1>
        <p style={{ color: "#64748b", fontSize: 14, lineHeight: 1.6, maxWidth: 720 }}>
          SDN/NFV 專利依 AI 關聯程度分為四類，對照六個管轄局的申請分佈。紅框標記目前<strong>零申請</strong>的類別
          × 管轄局組合——這是目前資料集能支撐的白地訊號；完整的「專利 vs 論文」雙軸白地象限分析，
          待補入論文檢索資料後再上線。
        </p>
      </div>

      <div className="chart-card-v2">
        <TechCountryHeatmap
          data={matrix}
          whiteSpacePairs={whiteSpacePairs}
          title="AI 關聯分類 × 管轄局（紅框＝零申請）"
          rowAxisName="AI 關聯分類"
          colAxisName="管轄局"
        />
      </div>
    </div>
  );
}
