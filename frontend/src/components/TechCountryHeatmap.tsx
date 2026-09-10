import React, { useMemo } from "react";
import ReactECharts from "echarts-for-react";
import type { MatrixData, WhiteSpacePair } from "../types";
import { PATENT_CLASS_AXIS_RICH, patentClassAxisRichTwoLines, patentClassTooltipHtml } from "../utils/classificationLabels";

interface Props {
  data: MatrixData;
  whiteSpacePairs?: WhiteSpacePair[];
  onChartClick?: (params: { tech: string; country: string }) => void;
  title?: string;
  rowAxisName?: string;
  colAxisName?: string;
}

export default function TechCountryHeatmap({
  data,
  whiteSpacePairs = [],
  onChartClick,
  title = "技術×國家 專利地圖（紅框=白地）",
  rowAxisName = "IPC 分類號／主題",
  colAxisName = "國家/地區",
}: Props) {
  const layout = useMemo(() => {
    if (data.row_labels.length === 0 || data.col_labels.length === 0) return null;
    const rows = data.row_labels.length;
    const cols = data.col_labels.length;
    const rawH = 100 + rows * 40 + Math.min(cols * 5, 60);
    const h = Math.min(620, Math.max(380, rawH));
    const left = Math.min(400, 200 + Math.max(...data.row_labels.map((s) => s.length), 6) * 5);
    return { chartHeight: h, gridLeft: left, bottomPad: Math.max(80, 48) };
  }, [data]);

  if (!layout) {
    return <div style={{ height: 350, display: "flex", alignItems: "center", justifyContent: "center", color: "#888" }}>暫無資料</div>;
  }

  const { chartHeight, gridLeft, bottomPad } = layout;

  const whiteSpaceSet = new Set(
    whiteSpacePairs.map(p => `${p.tech}||${p.country}`),
  );

  const heatmapData: Array<[number, number, number] | { value: [number, number, number]; itemStyle: object }> = [];
  data.row_labels.forEach((tech, rowIdx) => {
    data.col_labels.forEach((country, colIdx) => {
      const val = data.values[rowIdx]?.[colIdx] ?? 0;
      const isWhiteSpace = whiteSpaceSet.has(`${tech}||${country}`);
      if (isWhiteSpace) {
        heatmapData.push({
          value: [colIdx, rowIdx, val],
          itemStyle: { borderColor: "#e53e3e", borderWidth: 2 },
        });
      } else {
        heatmapData.push([colIdx, rowIdx, val]);
      }
    });
  });

  const maxVal = Math.max(
    ...heatmapData.map(d => (Array.isArray(d) ? d[2] : d.value[2])),
    1,
  );
  const nCells = data.row_labels.length * data.col_labels.length;
  const showCellLabels = nCells <= 48;

  const option = {
    animation: false,
    title: { text: title, left: "center", textStyle: { fontSize: 15 } },
    tooltip: {
      position: "top",
      formatter: (p: { data: [number, number, number] | { value: [number, number, number] } }) => {
        const v = Array.isArray(p.data) ? p.data : p.data.value;
        const tech = data.row_labels[v[1]];
        const country = data.col_labels[v[0]];
        const isWS = whiteSpaceSet.has(`${tech}||${country}`);
        return `${patentClassTooltipHtml(tech)}<br/>國家／地區：<b>${country}</b><br/>件數：<b>${v[2]}</b>${isWS ? " <span style=\"color:#e53e3e\">[白地]</span>" : ""}`;
      },
    },
    grid: { top: 64, bottom: bottomPad, left: gridLeft, right: 56 },
    xAxis: {
      type: "category",
      data: data.col_labels,
      name: colAxisName,
      nameTextStyle: { fontSize: 13 },
      axisLabel: { fontSize: 12 },
    },
    yAxis: {
      type: "category",
      data: data.row_labels,
      name: rowAxisName,
      nameTextStyle: { fontSize: 13 },
      nameGap: 18,
      axisLabel: {
        width: gridLeft - 28,
        overflow: "none",
        interval: 0,
        hideOverlap: false,
        margin: 12,
        formatter: (v: string) => patentClassAxisRichTwoLines(v, 40),
        rich: PATENT_CLASS_AXIS_RICH,
      },
    },
    visualMap: {
      min: 0,
      max: maxVal,
      calculable: true,
      orient: "horizontal",
      left: "center",
      bottom: 4,
      textStyle: { fontSize: 12 },
      inRange: { color: ["#fff7ed", "#fdba74", "#f97316", "#c2410c"] },
    },
    series: [
      {
        name: "專利件數",
        type: "heatmap",
        data: heatmapData,
        label: { show: showCellLabels, fontSize: 11, fontWeight: 600 },
        emphasis: { itemStyle: { shadowBlur: 10, shadowColor: "rgba(0,0,0,0.5)" } },
      },
    ],
  };

  const handleClick = (params: { data: [number, number, number] | { value: [number, number, number] } }) => {
    if (!onChartClick) return;
    const v = Array.isArray(params.data) ? params.data : params.data.value;
    onChartClick({ tech: data.row_labels[v[1]], country: data.col_labels[v[0]] });
  };

  return (
    <ReactECharts
      option={option}
      style={{ height: chartHeight, width: "100%" }}
      opts={{ renderer: "canvas" }}
      onEvents={{ click: handleClick }}
    />
  );
}
