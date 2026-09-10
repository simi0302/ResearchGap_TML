import React from "react";
import ReactECharts from "echarts-for-react";
import type { CountryDistributionData } from "../types";

// Validated 8-hue categorical order (CVD-safe adjacent pairs) — see dataviz skill.
// Never cycled; an 8th+ series folds into "其他" upstream in sdnFixtures.ts.
const CATEGORICAL_PALETTE = [
  "#2a78d6", "#eb6834", "#1baf7a", "#eda100",
  "#e87ba4", "#008300", "#4a3aa7", "#e34948",
];

interface Props {
  data: CountryDistributionData;
  onChartClick?: (params: { assignee: string; jurisdiction: string }) => void;
}

export default function CountryDistributionChart({ data, onChartClick }: Props) {
  if (!data || data.assignees.length === 0) {
    return <div style={{ height: 350, display: "flex", alignItems: "center", justifyContent: "center", color: "#888" }}>暫無資料</div>;
  }

  const series = data.assignees.map((assignee, i) => ({
    name: assignee,
    type: "bar",
    stack: "total",
    itemStyle: { color: CATEGORICAL_PALETTE[i % CATEGORICAL_PALETTE.length] },
    data: data.jurisdictions.map((_, j) => data.values[j]?.[i] ?? 0),
  }));

  const option = {
    animation: false,
    title: { text: "各申請人國家分佈", left: "center" },
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    legend: { bottom: 0, type: "scroll" },
    grid: { left: 12, right: 20, top: 52, bottom: 72, containLabel: true },
    xAxis: {
      type: "category",
      name: "國家/地區",
      data: data.jurisdictions,
    },
    yAxis: {
      type: "value",
      name: "件數",
    },
    series,
  };

  const handleClick = (params: { name: string; seriesName: string }) => {
    if (!onChartClick) return;
    onChartClick({ jurisdiction: params.name, assignee: params.seriesName });
  };

  return (
    <ReactECharts
      option={option}
      style={{ height: 350, width: "100%" }}
      opts={{ renderer: "canvas" }}
      onEvents={{ click: handleClick }}
    />
  );
}
