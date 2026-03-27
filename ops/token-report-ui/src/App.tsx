import {
  ColdStartBanner,
  EfficiencyScorecard,
  ExecutiveSummary,
  IssueLeaderboard,
  OutlierAnalysis,
  PerProductBreakdown,
  PerStageTrend,
  PerTicketCostTrend,
  ReportFooter,
  ReportHeader,
  StageEfficiency,
  reportCSS,
} from "./components/index.ts";
import analysisData from "./data/analysis.json";
import type { AnalysisData, Inflection, Outlier } from "./types.ts";

const data = analysisData as AnalysisData;
const isColdStart = data.cold_start === true && data.data_span_days < 7;

/** Normalize inflections/outliers from the dual union shape. */
function normalizeInflections(raw: AnalysisData["inflections"]): Inflection[] {
  if (Array.isArray(raw)) return raw;
  return raw?.items ?? [];
}

function normalizeOutliers(raw: AnalysisData["outliers"]): Outlier[] {
  if (Array.isArray(raw)) return raw;
  return raw?.items ?? [];
}

export default function App() {
  const es = data.executive_summary;
  const sc = data.efficiency_scorecard;
  const inflections = normalizeInflections(data.inflections);
  const outliers = normalizeOutliers(data.outliers);

  // Compute derived ExecutiveSummary props from raw analysis.json
  const totalTokens = es.total_tokens.value;
  const tokensPerIssueMedian = data.per_ticket_trend.median;
  const tokensPerIssueMean = data.per_ticket_trend.mean;
  const uniqueIssues = es.unique_issues.value;
  const cacheHitRate = (sc.cache_efficiency.current ?? 0) * 100;

  // WoW deltas computed from scorecard trends where available
  const cacheWow =
    sc.cache_efficiency.trend_7d != null
      ? Math.round(
          ((sc.cache_efficiency.current - sc.cache_efficiency.trend_7d) /
            (sc.cache_efficiency.trend_7d || 1)) *
            100,
        )
      : null;

  return (
    <>
      {/* biome-ignore lint/security/noDangerouslySetInnerHtml: report CSS is a static build-time string, not user input */}
      <style dangerouslySetInnerHTML={{ __html: reportCSS }} />
      <ReportHeader
        today={data.analyzed_at.slice(0, 10)}
        recordCount={data.record_count}
        dataSpanDays={data.data_span_days}
      />
      {isColdStart && (
        <ColdStartBanner
          dataSpanDays={data.data_span_days}
          message={data.message}
        />
      )}
      <ExecutiveSummary
        totalTokens={totalTokens}
        tokensDelta={null}
        tokensPerIssueMedian={tokensPerIssueMedian}
        tokensPerIssueMean={tokensPerIssueMean}
        tokPerIssueWow={null}
        uniqueIssues={uniqueIssues}
        cacheHitRate={cacheHitRate}
        cacheWow={cacheWow}
      />
      <EfficiencyScorecard
        scorecard={sc}
        series={data.daily_series}
        coldStart={isColdStart}
      />
      <PerStageTrend
        perStageTrend={data.per_stage_trend}
        inflections={inflections}
        coldStart={isColdStart}
        dataSpanDays={data.data_span_days}
      />
      <PerTicketCostTrend
        perTicket={data.per_ticket_trend}
        coldStart={isColdStart}
        dataSpanDays={data.data_span_days}
      />
      <OutlierAnalysis
        outliers={outliers}
        coldStart={isColdStart}
        dataSpanDays={data.data_span_days}
      />
      {/* TODO: IssueLeaderboard data not in current analysis.json shape */}
      <IssueLeaderboard leaderboard={[]} />
      <StageEfficiency perStageSpend={data.per_stage_spend} />
      <PerProductBreakdown perProduct={data.per_product} />
      <ReportFooter />
    </>
  );
}
