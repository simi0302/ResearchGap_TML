import React, { useMemo } from "react";
import ReactECharts from "echarts-for-react";
import type { YearlyTrendData } from "../types";

interface Props {
  data: YearlyTrendData;
  onChartClick?: (params: { year: number; type: "annual" | "cumulative" }) => void;
}

function buildCumulative(counts: number[]): number[] {
  const out: number[] = [];
  let sum = 0;
  for (const c of counts) {
    sum += c;
    out.push(sum);
  }
  return out;
}

export default function YearlyTrendChart({ data, onChartClick }: Props) {
  const cumulative = useMemo(
    () =>
      data.cumulative_publication_counts?.length === data.years.length
        ? data.cumulative_publication_counts
        : buildCumulative(data.publication_counts),
    [data.cumulative_publication_counts, data.publication_counts, data.years.length],
  );

  if (!data || data.years.length === 0) {
    return (
      <div style={{ height: 350, display: "flex", alignItems: "center", justifyContent: "center", color: "#888" }}>
        暫無資料
      </div>
    );
  }

  const yearRange = `${data.years[0]}–${data.years[data.years.length - 1]}`;

  const option = {
    animation: false,
    title: {
      text: `公開專利累積趨勢（${yearRange}）`,
      subtext: "以公開年統計；累積曲線反映母體成長（對齊 GPSS 公開日檢索口径）",
      left: "center",
      textStyle: { fontSize: 15 },
      subtextStyle: { fontSize: 11, color: "#64748b", lineHeight: 16 },
    },
    tooltip: { trigger: "axis" },
    legend: { data: ["累積公開件數", "當年新增公開"], bottom: 0 },
    grid: { left: 12, right: 16, top: 72, bottom: 52, containLabel: true },
    xAxis: {
      type: "category",
      name: "公開年",
      data: data.years.map(String),
    },
    yAxis: [
      {
        type: "value",
        name: "累積件數",
        position: "left",
      },
      {
        type: "value",
        name: "當年件數",
        position: "right",
        splitLine: { show: false },
      },
    ],
    color: ["#ea580c", "#fdba74"],
    series: [
      {
        name: "累積公開件數",
        type: "line",
        yAxisIndex: 0,
        data: cumulative,
        smooth: true,
        lineStyle: { width: 3 },
        areaStyle: { opacity: 0.1 },
      },
      {
        name: "當年新增公開",
        type: "bar",
        yAxisIndex: 1,
        data: data.publication_counts,
        barMaxWidth: 28,
        itemStyle: { opacity: 0.85 },
      },
    ],
  };

  const handleClick = (params: { dataIndex: number; seriesName: string }) => {
    if (!onChartClick) return;
    const year = data.years[params.dataIndex];
    const type = params.seriesName === "累積公開件數" ? "cumulative" : "annual";
    onChartClick({ year, type });
  };

  return (
    <ReactECharts
      option={option}
      style={{ height: 380, width: "100%" }}
      opts={{ renderer: "canvas" }}
      onEvents={{ click: handleClick }}
    />
  );
}
