/**
 * Pure reshape functions turning SDN_REPORT_RAW (verbatim data already published
 * in the team's own SDN/NFV report) into the shapes existing chart components expect.
 * No numbers are invented here — every value traces back to SDN_REPORT_RAW.
 */
import { SDN_REPORT_RAW } from "./sdnReportRaw";
import type {
  YearlyTrendData,
  CountryDistributionData,
  AssigneeRankingData,
  MatrixData,
} from "../types";

const JUR_ORDER = ["US", "EP", "JP", "TW", "SG", "MY"] as const;

const CATEGORY_LABEL_ZH: Record<string, string> = {
  network_slicing_baseline: "網路切片基礎技術",
  ai_related_orchestration: "AI 關聯編排",
  core_agentic_ai: "核心代理型 AI",
  exclude_or_low_weight: "排除／低權重",
};

export function toYearlyTrendData(): YearlyTrendData {
  const rows = SDN_REPORT_RAW.year_trend;
  const years = rows.map((r) => Number(r.year));
  const publication_counts = rows.map((r) => r.total);
  const cumulative_publication_counts: number[] = [];
  let sum = 0;
  for (const c of publication_counts) {
    sum += c;
    cumulative_publication_counts.push(sum);
  }
  const by_jurisdiction: Record<string, number[]> = {
    US: rows.map((r) => r.us),
    EP: rows.map((r) => r.ep),
    JP: rows.map((r) => r.jp),
    TW: rows.map((r) => r.tw),
  };
  return {
    years,
    // no independently-tracked filing-date series in the source report;
    // reuse publication_counts rather than inventing a separate number.
    filing_counts: publication_counts,
    publication_counts,
    cumulative_publication_counts,
    by_jurisdiction,
  };
}

const MAX_STACKED_SERIES = 7;

export function toCountryDistributionData(): CountryDistributionData {
  const jurCompany = SDN_REPORT_RAW.jur_company as unknown as Record<
    string,
    { company: string; count: number }[]
  >;
  const jurisdictions = JUR_ORDER.filter((j) => jurCompany[j]);

  // Fold to the top N assignees by total count so the stacked chart stays
  // legible (an 8th+ series is never a generated hue — it folds into "其他").
  const totals = new Map<string, number>();
  jurisdictions.forEach((j) =>
    jurCompany[j].forEach((row) => totals.set(row.company, (totals.get(row.company) ?? 0) + row.count)),
  );
  const topAssignees = Array.from(totals.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_STACKED_SERIES)
    .map(([company]) => company);
  const topSet = new Set(topAssignees);
  const assignees = [...topAssignees, "其他"];

  const values: number[][] = jurisdictions.map((j) => {
    const lookup = new Map(jurCompany[j].map((row) => [row.company, row.count]));
    const otherSum = jurCompany[j]
      .filter((row) => !topSet.has(row.company))
      .reduce((sum, row) => sum + row.count, 0);
    return [...topAssignees.map((a) => lookup.get(a) ?? 0), otherSum];
  });

  return { jurisdictions: [...jurisdictions], assignees, values };
}

export function toAssigneeRankingData(): AssigneeRankingData {
  const top = SDN_REPORT_RAW.top_assignees;
  const assigneeJur = SDN_REPORT_RAW.assignee_jur as Record<string, Record<string, number>>;
  const assignees = top.map((r) => r.company);
  const counts = top.map((r) => r.count);
  const by_jurisdiction: Record<string, number[]> = {};
  for (const jur of JUR_ORDER) {
    by_jurisdiction[jur] = assignees.map((a) => assigneeJur[a]?.[jur] ?? 0);
  }
  return { assignees, counts, by_jurisdiction };
}

export function toAgenticCategoryMatrix(): MatrixData {
  const jurAgentic = SDN_REPORT_RAW.jur_agentic as Record<string, Record<string, number>>;
  const categories = Object.keys(CATEGORY_LABEL_ZH);
  const jurisdictions = JUR_ORDER.filter((j) => jurAgentic[j]);
  const values = categories.map((cat) => jurisdictions.map((j) => jurAgentic[j]?.[cat] ?? 0));
  return {
    row_labels: categories.map((c) => CATEGORY_LABEL_ZH[c]),
    col_labels: [...jurisdictions],
    values,
  };
}

export interface KpiStats {
  total: number;
  jurisdictionCount: number;
  coreAgenticAi: number;
  aiOrchestration: number;
  twCount: number;
  sourceCountryCount: number;
  generated: string;
}

export function toKpiStats(): KpiStats {
  const agentic = SDN_REPORT_RAW.agentic_dist as unknown as { cat: string; count: number }[];
  const findCat = (cat: string) => agentic.find((r) => r.cat === cat)?.count ?? 0;
  const tw = (SDN_REPORT_RAW.jur_dist as unknown as { jur: string; count: number }[]).find(
    (r) => r.jur === "TW",
  );
  return {
    total: SDN_REPORT_RAW.total,
    jurisdictionCount: SDN_REPORT_RAW.jur_dist.length,
    coreAgenticAi: findCat("core_agentic_ai"),
    aiOrchestration: findCat("ai_related_orchestration"),
    twCount: tw?.count ?? 0,
    sourceCountryCount: SDN_REPORT_RAW.region_dist.length,
    generated: SDN_REPORT_RAW.generated,
  };
}

export interface TwDeepDive {
  byRegion: { region: string; count: number }[];
  byCompany: { region: string; company: string; count: number }[];
}

export function toTwDeepDive(): TwDeepDive {
  return {
    byRegion: [...SDN_REPORT_RAW.tw_region],
    byCompany: [...SDN_REPORT_RAW.tw_detail],
  };
}

export function toJurDist(): { jur: string; count: number }[] {
  return [...SDN_REPORT_RAW.jur_dist];
}
