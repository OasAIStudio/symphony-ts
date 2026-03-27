/**
 * TypeScript interfaces matching the analysis.json shape
 * produced by computeAnalysis() in ops/token-report.mjs.
 */

export interface MetricWithTrend {
  current: number;
  trend_7d: number;
  trend_30d: number;
  /** Daily values produced by buildDailyMetricSeries() — 30-day rolling window */
  series?: number[];
}

export interface FailureRatePeriod {
  [stage: string]: number;
}

export interface FailureRate {
  current: FailureRatePeriod;
  trend_7d: FailureRatePeriod;
  trend_30d: FailureRatePeriod;
}

export interface EfficiencyScorecard {
  cache_efficiency: MetricWithTrend;
  output_ratio: MetricWithTrend;
  wasted_context: MetricWithTrend;
  tokens_per_turn: MetricWithTrend;
  first_pass_rate: MetricWithTrend;
  failure_rate: FailureRate;
}

export interface ExecutiveSummary {
  total_tokens: { value: number };
  total_stages: { value: number };
  unique_issues: { value: number };
  data_span_days: number;
}

export interface StageSpend {
  total_tokens: number;
  count: number;
  completed: number;
  failed: number;
}

export interface ConfigChange {
  date: string;
  timestamp?: string;
  changed_files?: string[];
}

export interface StageTrend {
  daily_avg: number | Record<string, number>;
  wow_delta?: number;
  config_changes?: ConfigChange[];
}

export interface PerTicketTrend {
  median: number;
  mean: number;
  ticket_count: number;
}

export interface ProductData {
  total_tokens: number;
  total_stages: number;
  unique_issues: number;
}

export interface Inflection {
  date: string;
  metric: string;
  direction: string;
  magnitude: number;
  context: string;
}

export interface Outlier {
  issue: string;
  stage: string;
  tokens: number;
  z_score: number;
  reason: string;
}

export interface InsufficientData {
  status: string;
  items: never[];
}

export interface DailySeries {
  cacheEff?: number[];
  outputRatio?: number[];
  wastedCtx?: number[];
  tokPerTurn?: number[];
  firstPass?: number[];
  failureRate?: number[];
}

export interface AnalysisData {
  cold_start_tier: "<7d" | "7-29d" | ">=30d";
  cold_start?: boolean;
  message?: string;
  analyzed_at: string;
  data_span_days: number;
  record_count: number;
  efficiency_scorecard: EfficiencyScorecard;
  executive_summary: ExecutiveSummary;
  per_stage_spend: Record<string, StageSpend>;
  per_stage_trend: Record<string, StageTrend>;
  per_ticket_trend: PerTicketTrend;
  /** Daily median-per-ticket series produced by buildDailyMetricSeries() */
  per_ticket_series?: number[];
  per_product: Record<string, ProductData>;
  daily_series?: DailySeries;
  inflections: Inflection[] | InsufficientData;
  outliers: Outlier[] | InsufficientData;
}
