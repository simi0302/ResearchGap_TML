/**
 * Frontend TypeScript interfaces mirroring the backend Python dataclass models.
 */

export type Jurisdiction = "TW" | "US" | "EP" | "JP" | "SG" | "TH" | "VN" | "MY";

// ---------------------------------------------------------------------------
// Core patent models
// ---------------------------------------------------------------------------

export interface PatentRecord {
  /** 資料庫主鍵；列表 API 會一併回傳，供詳情查詢 */
  id?: number;
  publication_number: string;
  jurisdiction: Jurisdiction;
  title: string;
  assignees: string[];
  ipc: string[];
  cpc: string[];
  publication_date: string | null; // ISO date string YYYY-MM-DD
  filing_date: string | null;      // ISO date string YYYY-MM-DD
  abstract: string | null;
  inventors: string[] | null;
  family_id: string | null;
}

export interface RawPatentRecord {
  source: string;
  publication_number: string | null;
  jurisdiction: string | null;
  title: string | null;
  assignees: string[] | null;
  ipc: string[] | null;
  cpc: string[] | null;
  publication_date: string | null;
  filing_date: string | null;
  abstract: string | null;
  inventors: string[] | null;
  family_id: string | null;
}

// ---------------------------------------------------------------------------
// Collector
// ---------------------------------------------------------------------------

export interface CollectorConfig {
  keywords_en: string[];
  keywords_zh: string[];
  jurisdictions: Jurisdiction[];
  retry_max: number;
  retry_delay_minutes: number;
}

export interface CollectionSummary {
  source: string;
  collected: number;
  failed: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Cleaner
// ---------------------------------------------------------------------------

export interface CleaningReport {
  deduplicated: number;
  normalized: number;
  invalid: number;
  invalid_records: string[]; // publication_numbers
}

// ---------------------------------------------------------------------------
// Analyzer
// ---------------------------------------------------------------------------

export interface AnalyzerFilters {
  jurisdictions: Jurisdiction[] | null;
  date_from: string | null; // ISO date string
  date_to: string | null;   // ISO date string
  assignees: string[] | null;
  ipc_codes: string[] | null;
  cpc_codes: string[] | null;
  keywords: string[] | null; // keyword search on title + abstract
}

// ---------------------------------------------------------------------------
// Chart / analysis result interfaces
// ---------------------------------------------------------------------------

export interface YearlyTrendData {
  years: number[];
  filing_counts: number[];
  publication_counts: number[];
  cumulative_publication_counts: number[];
  by_jurisdiction: Record<string, number[]>;
}

export interface CountryDistributionData {
  jurisdictions: string[];
  assignees: string[];
  values: number[][];
}

export interface AssigneeRankingData {
  assignees: string[];
  counts: number[];
  by_jurisdiction: Record<string, number[]>;
}

export interface IPCDistributionData {
  ipc_codes: string[];
  counts: number[];
  by_assignee: Record<string, number[]>;
}

export interface IpcTierReportData {
  tier3_labels: string[];
  tier3_counts: number[];
  tier4_labels: string[];
  tier4_counts: number[];
  patent_count: number;
  cht_patent_count: number;
  methodology_zh: string;
}

export interface IpcSearchStatsData {
  broad_query_zh: string;
  broad_count: number;
  refined_query_zh: string;
  refined_count: number;
  cht_refined_count: number;
}

export interface CPCDistributionData {
  cpc_codes: string[];
  counts: number[];
  by_assignee: Record<string, { codes: string[]; counts: number[] }>;
}

export interface TechLifecycleSeriesInsight {
  label: string;
  phase: string;
  cagr: number | null;
  early_sum: number;
  late_sum: number;
  total: number;
  formula_zh: string;
  caveat_zh: string;
}

export interface TechLifecycleData {
  years: number[];
  series: { label: string; counts: number[] }[];
  methodology_zh?: string;
  references?: { id: string; text: string; url: string }[];
  series_insights?: TechLifecycleSeriesInsight[];
}

export interface OpportunityRadarData {
  axes: string[];
  values_0_100: number[];
  axis_definitions: { name: string; formula_zh: string; raw_note: string }[];
  references: { id: string; text: string; url: string }[];
  methodology_zh: string;
  cht_takeaway_zh: string;
}

export interface MatrixData {
  row_labels: string[];
  col_labels: string[];
  values: number[][];
  metadata?: Record<string, unknown>;
}

/** 美／歐／台統一：每列一細項，各區年度件數（2016–2026，無資料為 0） */
export interface AiCoreYearlyRow {
  parent_zh: string;
  child_zh: string;
  us: number[];
  ep: number[];
  tw: number[];
}

export interface AiCoreYearlyBundle {
  year_columns: number[];
  regions: { code: string; label_zh: string }[];
  rows: AiCoreYearlyRow[];
  metadata?: Record<string, unknown>;
}

export interface WhiteSpacePair {
  tech: string;
  country: string;
  global_growth: number;
  local_share: number;
}

export interface WhiteSpaceData {
  tech_country_pairs: WhiteSpacePair[];
  summary_text: string;
}

export interface NetworkNode {
  id: string;
  label: string;
  type: "assignee" | "tech" | "jurisdiction" | "cpc";
  size: number;
}

export interface NetworkEdge {
  source: string;
  target: string;
  weight: number;
}

export interface NetworkGraphData {
  nodes: NetworkNode[];
  edges: NetworkEdge[];
}

export interface SemanticMapPoint {
  patent_id: number;
  publication_number: string;
  title: string;
  jurisdiction: Jurisdiction;
  ipc_primary: string;
  x: number;
  y: number;
  cluster_id: number;
}

export interface SemanticDensityHotspot {
  rank: number;
  x: number;
  y: number;
  radius: number;
  patent_count: number;
  grid_count: number;
  label_zh: string;
}

export interface SemanticMapData {
  points: SemanticMapPoint[];
  density_hotspots?: SemanticDensityHotspot[];
  density_grid: {
    x_min?: number;
    x_max?: number;
    y_min?: number;
    y_max?: number;
    grid_size?: number;
    counts?: number[];
    max_count?: number;
    sparse_regions?: { x: number; y: number; count?: number }[];
  };
  cluster_summary: { cluster_id: number; count: number; label: string }[];
  meta: {
    ready?: boolean;
    point_count?: number;
    displayed_count?: number;
    sampled?: boolean;
    embedding_model?: string;
    reducer?: string;
    built_at?: string;
    methodology_zh?: string;
    message_zh?: string;
  };
}

// ---------------------------------------------------------------------------
// API response wrappers
// ---------------------------------------------------------------------------

export interface PaginatedResponse<T> {
  data: T[];
  total: number;
  page: number;
  page_size: number;
  message?: string; // present when total === 0
}

export interface ApiError {
  error: string;
  field?: string;
  reason?: string;
}
