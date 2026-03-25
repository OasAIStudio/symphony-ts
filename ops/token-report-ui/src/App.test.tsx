import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import App from "./App.tsx";
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
  StageUtilizationChart,
  TicketCostChart,
} from "./components/index.ts";
import analysisData from "./data/analysis.json";
import {
  buildAreaString,
  buildPointsString,
  computeYGrid,
  extractSortedDates,
  formatAxisValue,
  formatDateLabel,
  linearScale,
  pickTickIndices,
  round,
} from "./lib/chart-utils.ts";
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

// ─── chart-utils unit tests ───

describe("chart-utils", () => {
  it("round() rounds to specified decimals", () => {
    expect(round(Math.PI, 2)).toBe(3.14);
    expect(round(Math.PI, 0)).toBe(3);
    expect(round(1000.5)).toBe(1001);
  });

  it("linearScale maps value to range", () => {
    expect(linearScale(50, 0, 100, 0, 200)).toBe(100);
    expect(linearScale(0, 0, 100, 0, 200)).toBe(0);
    expect(linearScale(100, 0, 100, 0, 200)).toBe(200);
  });

  it("linearScale clamps out-of-range values", () => {
    expect(linearScale(150, 0, 100, 0, 200)).toBe(200);
    expect(linearScale(-10, 0, 100, 0, 200)).toBe(0);
  });

  it("formatDateLabel converts YYYY-MM-DD to short label", () => {
    expect(formatDateLabel("2026-03-05")).toBe("Mar 05");
    expect(formatDateLabel("2026-01-15")).toBe("Jan 15");
    expect(formatDateLabel("2026-12-31")).toBe("Dec 31");
  });

  it("pickTickIndices returns evenly spaced indices", () => {
    expect(pickTickIndices(10, 3)).toEqual([0, 5, 9]);
    expect(pickTickIndices(3, 5)).toEqual([0, 1, 2]);
    expect(pickTickIndices(5, 5)).toEqual([0, 1, 2, 3, 4]);
  });

  it("computeYGrid returns values from max to min", () => {
    const grid = computeYGrid(0, 100, 4);
    expect(grid).toEqual([100, 75, 50, 25, 0]);
  });

  it("formatAxisValue uses K/M suffixes", () => {
    expect(formatAxisValue(1500000)).toBe("1.5M");
    expect(formatAxisValue(52000)).toBe("52K");
    expect(formatAxisValue(500)).toBe("500");
  });

  it("buildPointsString joins coordinates", () => {
    const result = buildPointsString([
      [10, 20],
      [30, 40],
    ]);
    expect(result).toBe("10,20 30,40");
  });

  it("buildAreaString creates closed polygon", () => {
    const result = buildAreaString(
      [
        [10, 20],
        [30, 40],
      ],
      100,
    );
    expect(result).toContain("10,20");
    expect(result).toContain("30,40");
    expect(result).toContain("30,100");
    expect(result).toContain("10,100");
  });

  it("buildAreaString returns empty for no coords", () => {
    expect(buildAreaString([], 100)).toBe("");
  });

  it("extractSortedDates extracts dates from stage trend data", () => {
    const stageData = {
      implement: { daily_avg: { "2026-03-01": 100, "2026-03-03": 300 } },
      review: { daily_avg: { "2026-03-02": 200, "2026-03-01": 150 } },
    };
    const dates = extractSortedDates(stageData);
    expect(dates).toEqual(["2026-03-01", "2026-03-02", "2026-03-03"]);
  });

  it("extractSortedDates handles scalar daily_avg", () => {
    const stageData = {
      implement: { daily_avg: 5000 },
    };
    const dates = extractSortedDates(stageData);
    expect(dates).toEqual([]);
  });
});

// ─── StageUtilizationChart tests ───

describe("StageUtilizationChart", () => {
  const dateKeyedTrend: Record<
    string,
    { daily_avg: Record<string, number>; wow_delta: number }
  > = {
    investigate: {
      daily_avg: {
        "2026-03-01": 50000,
        "2026-03-02": 55000,
        "2026-03-03": 60000,
      },
      wow_delta: -0.05,
    },
    implement: {
      daily_avg: {
        "2026-03-01": 150000,
        "2026-03-02": 160000,
        "2026-03-03": 170000,
      },
      wow_delta: 0.03,
    },
  };

  it("renders stacked area chart with date-keyed data", () => {
    const html = renderToString(
      <StageUtilizationChart stageData={dateKeyedTrend} />,
    );
    expect(html).toContain("svg");
    expect(html).toContain("Per-stage utilization stacked area chart");
    // Should have polygon elements for areas
    expect(html).toContain("polygon");
    // Should have polyline elements for lines
    expect(html).toContain("polyline");
    // Should contain date labels
    expect(html).toContain("Mar 01");
    expect(html).toContain("Mar 03");
    // Should contain legend items
    expect(html).toContain("investigate");
    expect(html).toContain("implement");
  });

  it("renders insufficient data state for scalar daily_avg", () => {
    const html = renderToString(
      <StageUtilizationChart stageData={data.per_stage_trend} />,
    );
    // Sample analysis.json has scalar daily_avg, so no dates → insufficient data
    expect(html).toContain("Insufficient data");
  });

  it("renders config change markers", () => {
    const html = renderToString(
      <StageUtilizationChart
        stageData={dateKeyedTrend}
        configChanges={[{ date: "2026-03-02" }]}
      />,
    );
    expect(html).toContain("\u2699"); // gear icon
  });
});

// ─── TicketCostChart tests ───

describe("TicketCostChart", () => {
  const sampleSeries = [45000, 52000, 48000, 61000, 55000, 58000, 53000];

  it("renders line chart with series data", () => {
    const html = renderToString(
      <TicketCostChart
        perTicket={data.per_ticket_trend}
        series={sampleSeries}
      />,
    );
    expect(html).toContain("svg");
    expect(html).toContain("Per-ticket cost trend chart");
    // Should have polyline for main data line
    expect(html).toContain("polyline");
    // Should have polygon for area fill
    expect(html).toContain("polygon");
    // Should have median reference line label
    expect(html).toContain("med");
    // Should have mean reference line label
    expect(html).toContain("avg");
    // Should have legend
    expect(html).toContain("Median");
    expect(html).toContain("Mean");
    expect(html).toContain("Per-ticket");
  });

  it("renders insufficient data state without series", () => {
    const html = renderToString(
      <TicketCostChart perTicket={data.per_ticket_trend} />,
    );
    expect(html).toContain("Insufficient series data");
    // Should still show median/mean as static text
    expect(html).toContain("52K");
    expect(html).toContain("59K");
  });

  it("renders with minimal series data", () => {
    const html = renderToString(
      <TicketCostChart
        perTicket={{ median: 50000, mean: 55000, ticket_count: 10 }}
        series={[40000, 60000]}
      />,
    );
    expect(html).toContain("polyline");
    expect(html).toContain("med");
  });
});
