import { describe, it, expect } from "vitest";
import { SDN_REPORT_RAW } from "./sdnReportRaw";
import {
  toYearlyTrendData,
  toCountryDistributionData,
  toAssigneeRankingData,
  toAgenticCategoryMatrix,
  toKpiStats,
  toTwDeepDive,
} from "./sdnFixtures";

describe("sdnFixtures reshape functions", () => {
  it("toKpiStats matches the raw report totals exactly", () => {
    const stats = toKpiStats();
    expect(stats.total).toBe(SDN_REPORT_RAW.total);
    expect(stats.jurisdictionCount).toBe(SDN_REPORT_RAW.jur_dist.length);
    expect(stats.sourceCountryCount).toBe(SDN_REPORT_RAW.region_dist.length);
  });

  it("toYearlyTrendData produces one cumulative/publication count per year, monotonically increasing cumulative", () => {
    const data = toYearlyTrendData();
    expect(data.years.length).toBe(SDN_REPORT_RAW.year_trend.length);
    expect(data.publication_counts.length).toBe(data.years.length);
    expect(data.cumulative_publication_counts.length).toBe(data.years.length);
    for (let i = 1; i < data.cumulative_publication_counts.length; i++) {
      expect(data.cumulative_publication_counts[i]).toBeGreaterThanOrEqual(
        data.cumulative_publication_counts[i - 1],
      );
    }
    const total = data.publication_counts.reduce((a, b) => a + b, 0);
    expect(data.cumulative_publication_counts.at(-1)).toBe(total);
  });

  it("toCountryDistributionData caps stacked series at top assignees + 其他", () => {
    const data = toCountryDistributionData();
    expect(data.assignees.at(-1)).toBe("其他");
    expect(data.assignees.length).toBeLessThanOrEqual(8);
    expect(data.values.length).toBe(data.jurisdictions.length);
    data.values.forEach((row) => expect(row.length).toBe(data.assignees.length));
  });

  it("toAssigneeRankingData assignees/counts stay aligned", () => {
    const data = toAssigneeRankingData();
    expect(data.assignees.length).toBe(data.counts.length);
    expect(data.assignees.length).toBe(SDN_REPORT_RAW.top_assignees.length);
  });

  it("toAgenticCategoryMatrix values grid matches row/col label counts", () => {
    const matrix = toAgenticCategoryMatrix();
    expect(matrix.values.length).toBe(matrix.row_labels.length);
    matrix.values.forEach((row) => expect(row.length).toBe(matrix.col_labels.length));
  });

  it("toTwDeepDive returns non-empty region/company breakdowns", () => {
    const tw = toTwDeepDive();
    expect(tw.byRegion.length).toBeGreaterThan(0);
    expect(tw.byCompany.length).toBeGreaterThan(0);
  });
});
