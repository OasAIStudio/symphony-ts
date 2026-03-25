import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import App from "./App.tsx";
import analysisData from "./analysis.json";
import {
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
} from "./components/index.ts";
import type { AnalysisData } from "./types.ts";

const data = analysisData as AnalysisData;

describe("App", () => {
  it("renders without crashing", () => {
    const html = renderToString(<App />);
    expect(html).toContain("Symphony Token Report");
  });

  it("renders all 10 section headings", () => {
    const html = renderToString(<App />);
    expect(html).toContain("Executive Summary");
    expect(html).toContain("Efficiency Scorecard");
    expect(html).toContain("Per-Stage Utilization Trend");
    expect(html).toContain("Per-Ticket Cost Trend");
    expect(html).toContain("Outlier Analysis");
    expect(html).toContain("Issue Leaderboard");
    expect(html).toContain("Stage Efficiency");
    expect(html).toContain("Per-Product Breakdown");
    expect(html).toContain("SYMPH-131");
  });
});

describe("analysis.json shape", () => {
  it("has required top-level keys", () => {
    expect(analysisData).toHaveProperty("cold_start_tier");
    expect(analysisData).toHaveProperty("analyzed_at");
    expect(analysisData).toHaveProperty("data_span_days");
    expect(analysisData).toHaveProperty("record_count");
    expect(analysisData).toHaveProperty("efficiency_scorecard");
    expect(analysisData).toHaveProperty("executive_summary");
    expect(analysisData).toHaveProperty("per_stage_spend");
    expect(analysisData).toHaveProperty("per_stage_trend");
    expect(analysisData).toHaveProperty("per_ticket_trend");
    expect(analysisData).toHaveProperty("per_product");
    expect(analysisData).toHaveProperty("inflections");
    expect(analysisData).toHaveProperty("outliers");
  });

  it("has correct efficiency_scorecard metrics", () => {
    const sc = analysisData.efficiency_scorecard;
    for (const key of [
      "cache_efficiency",
      "output_ratio",
      "wasted_context",
      "tokens_per_turn",
      "first_pass_rate",
    ] as const) {
      expect(sc[key]).toHaveProperty("current");
      expect(sc[key]).toHaveProperty("trend_7d");
      expect(sc[key]).toHaveProperty("trend_30d");
    }
  });

  it("has correct executive_summary shape", () => {
    const es = analysisData.executive_summary;
    expect(es.total_tokens).toHaveProperty("value");
    expect(es.total_stages).toHaveProperty("value");
    expect(es.unique_issues).toHaveProperty("value");
    expect(es).toHaveProperty("data_span_days");
  });
});

describe("ReportHeader", () => {
  it("renders header with metadata", () => {
    const html = renderToString(
      <ReportHeader today="2026-03-20" recordCount={312} dataSpanDays={45} />,
    );
    expect(html).toContain("Symphony Token Report");
    expect(html).toContain("2026-03-20");
    expect(html).toContain("312");
    expect(html).toContain("45");
    expect(html).toContain("day span");
  });
});

describe("ExecutiveSummary", () => {
  it("renders KPI cards with data", () => {
    const html = renderToString(
      <ExecutiveSummary
        totalTokens={18420000}
        tokensDelta={null}
        tokensPerIssueMedian={52000}
        tokensPerIssueMean={59000}
        tokPerIssueWow={null}
        uniqueIssues={47}
        cacheHitRate={72}
        cacheWow={null}
      />,
    );
    expect(html).toContain("Executive Summary");
    expect(html).toContain("Total Tokens");
    expect(html).toContain("18,420,000");
    expect(html).toContain("Issues Processed");
    expect(html).toContain("Cache Hit Rate");
    expect(html).toContain("72");
    expect(html).toContain("%");
  });
});

describe("EfficiencyScorecard", () => {
  it("renders all 6 metric rows", () => {
    const html = renderToString(
      <EfficiencyScorecard scorecard={data.efficiency_scorecard} />,
    );
    expect(html).toContain("Efficiency Scorecard");
    expect(html).toContain("Cache Efficiency");
    expect(html).toContain("Output Ratio");
    expect(html).toContain("Wasted Context");
    expect(html).toContain("Tokens / Turn");
    expect(html).toContain("First-Pass Rate");
    expect(html).toContain("Failure Rate (all stages)");
  });
});

describe("PerStageTrend", () => {
  it("renders trend section with inflections", () => {
    const inflections = Array.isArray(data.inflections) ? data.inflections : [];
    const html = renderToString(
      <PerStageTrend
        perStageTrend={data.per_stage_trend}
        inflections={inflections}
      />,
    );
    expect(html).toContain("Per-Stage Utilization Trend");
    expect(html).toContain("Inflection");
  });
});

describe("PerTicketCostTrend", () => {
  it("renders ticket cost stats", () => {
    const html = renderToString(
      <PerTicketCostTrend perTicket={data.per_ticket_trend} />,
    );
    expect(html).toContain("Per-Ticket Cost Trend");
    expect(html).toContain("52,000");
    expect(html).toContain("59,000");
    expect(html).toContain("47");
    expect(html).toContain("tickets");
  });
});

describe("OutlierAnalysis", () => {
  it("renders outlier cards", () => {
    const outliers = Array.isArray(data.outliers) ? data.outliers : [];
    const html = renderToString(<OutlierAnalysis outliers={outliers} />);
    expect(html).toContain("Outlier Analysis");
    expect(html).toContain("SYMPH-98");
    expect(html).toContain("JONY-42");
    expect(html).toContain("3.2");
  });

  it("renders empty state", () => {
    const html = renderToString(<OutlierAnalysis outliers={[]} />);
    expect(html).toContain("No outliers detected");
  });
});

describe("IssueLeaderboard", () => {
  it("renders table with empty data", () => {
    const html = renderToString(<IssueLeaderboard leaderboard={[]} />);
    expect(html).toContain("Issue Leaderboard");
    expect(html).toContain("<table");
  });

  it("renders leaderboard items", () => {
    const items = [
      { identifier: "SYMPH-100", title: "Test issue", tokens: 100000 },
    ];
    const html = renderToString(<IssueLeaderboard leaderboard={items} />);
    expect(html).toContain("SYMPH-100");
    expect(html).toContain("Test issue");
    expect(html).toContain("100,000");
  });
});

describe("StageEfficiency", () => {
  it("renders stage cards", () => {
    const html = renderToString(
      <StageEfficiency perStageSpend={data.per_stage_spend} />,
    );
    expect(html).toContain("Stage Efficiency");
    expect(html).toContain("investigate");
    expect(html).toContain("implement");
    expect(html).toContain("validate");
  });
});

describe("PerProductBreakdown", () => {
  it("renders product table with share bars", () => {
    const html = renderToString(
      <PerProductBreakdown perProduct={data.per_product} />,
    );
    expect(html).toContain("Per-Product Breakdown");
    expect(html).toContain("symphony-ts");
    expect(html).toContain("jony-agent");
    expect(html).toContain("stickerlabs");
    expect(html).toContain("product-bar");
  });
});

describe("ReportFooter", () => {
  it("renders footer text", () => {
    const html = renderToString(<ReportFooter />);
    expect(html).toContain("SYMPH-131");
    expect(html).toContain("token-report.mjs");
  });
});
