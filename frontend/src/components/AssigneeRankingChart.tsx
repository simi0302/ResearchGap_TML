import React from "react";
import ReactECharts from "echarts-for-react";
import type { AssigneeRankingData } from "../types";

interface Props {
  data: AssigneeRankingData;
  onChartClick?: (params: { assignee: string }) => void;
}

export default function AssigneeRankingChart({ data, onChartClick }: Props) {
  if (!data || data.assignees.length === 0) {
    return <div style={{ height: 350, display: "flex", alignItems: "center", justifyContent: "center", color: "#888" }}>暫無資料</div>;
  }

  const option = {
    animation: false,
    tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
    grid: { left: 16, right: 40, top: 12, bottom: 12, containLabel: true },
    xAxis: {
      type: "value",
      name: "件數",
    },
    yAxis: {
      type: "category",
      data: [...data.assignees].reverse(),
      axisLabel: { fontSize: 12, interval: 0, margin: 8 },
    },
    series: [
      {
        name: "專利件數",
        type: "bar",
        data: [...data.counts].reverse(),
        itemStyle: { color: "#ea580c" },
        label: { show: true, position: "right", fontSize: 11 },
      },
    ],
  };

  const handleClick = (params: { name: string }) => {
    if (!onChartClick) return;
    onChartClick({ assignee: params.name });
  };

  return (
    <ReactECharts
      option={option}
      style={{ height: 540, width: "100%" }}
      opts={{ renderer: "canvas" }}
      onEvents={{ click: handleClick }}
    />
  );
}
