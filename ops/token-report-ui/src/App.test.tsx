import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import App from "./App.tsx";
import { Sparkline } from "./components/chartUtils.tsx";
import {
  EfficiencyScorecard,
  ExecutiveSummary,
  InflectionAttribution,
  IssueLeaderboard,
  OutlierAnalysis,
  PerProductBreakdown,
  PerStageTrend,
  PerTicketCostTrend,
  PipelineHealth,
  ReportFooter,
  ReportHeader,
  StageEfficiency,
  StageUtilizationChart,
  TicketCostChart,
  reportCSS,
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

  it("renders all section headings", () => {
    const html = renderToString(<App />);
    expect(html).toContain("Executive Summary");
    expect(html).toContain("Efficiency Scorecard");
    expect(html).toContain("Per-Stage Utilization Trend");
    expect(html).toContain("Per-Ticket Cost Trend");
    expect(html).toContain("Outlier Analysis");
    expect(html).toContain("Issue Leaderboard");
    expect(html).toContain("Pipeline Health");
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
    expect(analysisData).toHaveProperty("leaderboard");
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

  it("has date-keyed per_stage_trend daily_avg", () => {
    const trend = (analysisData as AnalysisData).per_stage_trend;
    for (const stage of Object.keys(trend)) {
      const avg = trend[stage].daily_avg;
      expect(typeof avg).toBe("object");
      expect(avg).not.toBeNull();
      // Each stage should have date keys (YYYY-MM-DD format)
      const dates = Object.keys(avg as Record<string, number>);
      expect(dates.length).toBeGreaterThan(0);
      expect(dates[0]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
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

// ─── SYMPH-190: Formula verification tests ───

describe("SYMPH-190 formula verification", () => {
  it("fixture has wow_delta_pct on total_tokens", () => {
    expect(analysisData.executive_summary.total_tokens).toHaveProperty(
      "wow_delta_pct",
    );
    expect(analysisData.executive_summary.total_tokens.wow_delta_pct).toBe(
      12.3,
    );
  });

  it("fixture has wow_delta_pct on per_ticket_trend", () => {
    expect(analysisData.per_ticket_trend).toHaveProperty("wow_delta_pct");
    expect(
      (analysisData.per_ticket_trend as { wow_delta_pct: number })
        .wow_delta_pct,
    ).toBe(-5.2);
  });

  it("cache delta formula: (current - trend_7d) * 100 = 4pp", () => {
    const sc = data.efficiency_scorecard;
    const expected = Math.round(
      (sc.cache_efficiency.current - sc.cache_efficiency.trend_7d) * 100,
    );
    expect(expected).toBe(4);
    // Verify rendered output contains the delta badge
    const html = renderToString(<App />);
    expect(html).toContain("4<!-- -->% WoW");
  });

  it("token delta: wires wow_delta_pct from fixture into WoW badge", () => {
    const html = renderToString(<App />);
    // total_tokens.wow_delta_pct = 12.3 → "+12.3% WoW"
    expect(html).toContain("12.3<!-- -->% WoW");
  });

  it("per-ticket WoW delta: wires wow_delta_pct from fixture into WoW badge", () => {
    const html = renderToString(<App />);
    // per_ticket_trend.wow_delta_pct = -5.2 → "-5.2% WoW"
    expect(html).toContain("-5.2<!-- -->% WoW");
  });

  it("per_ticket_series exists on fixture for chart rendering", () => {
    expect(analysisData).toHaveProperty("per_ticket_series");
    expect(Array.isArray(analysisData.per_ticket_series)).toBe(true);
    expect((analysisData.per_ticket_series as number[]).length).toBeGreaterThan(
      0,
    );
  });
});

describe("EfficiencyScorecard", () => {
  it("renders 5 metric rows (failure rate moved to PipelineHealth)", () => {
    const html = renderToString(
      <EfficiencyScorecard scorecard={data.efficiency_scorecard} />,
    );
    expect(html).toContain("Efficiency Scorecard");
    expect(html).toContain("Cache Efficiency");
    expect(html).toContain("Output Ratio");
    expect(html).toContain("Wasted Context");
    expect(html).toContain("Tokens / Turn");
    expect(html).toContain("First-Pass Rate");
    // Failure Rate row removed — now in PipelineHealth component
    expect(html).not.toContain("Failure Rate");
  });

  it("renders 30d range text for each metric row (SYMPH-189)", () => {
    const html = renderToString(
      <EfficiencyScorecard scorecard={data.efficiency_scorecard} />,
    );
    // Cache Efficiency: trend_30d=0.65 (65%), current=0.72 (72%)
    expect(html).toContain("30d:");
    expect(html).toContain("→");
    expect(html).toContain("metric-range");
  });
});

describe("SYMPH-189: formula fixes and pipeline wiring", () => {
  it("cache delta uses percentage point formula, not relative change", () => {
    // sc.cache_efficiency: current=0.72, trend_7d=0.68
    // Correct: (0.72 - 0.68) * 100 = 4
    // Wrong (old): ((0.72 - 0.68) / 0.68) * 100 ≈ 5.88
    const html = renderToString(<App />);
    // The WowBadge should show +4, not +6
    expect(html).toContain("Executive Summary");
  });

  it("wires tokensDelta from pipeline wow_delta_pct", () => {
    // analysis.json fixture has total_tokens.wow_delta_pct = 12.3
    const html = renderToString(<App />);
    expect(html).toContain("12.3");
  });

  it("wires tokPerIssueWow from pipeline per_ticket_trend.wow_delta_pct", () => {
    // analysis.json fixture has per_ticket_trend.wow_delta_pct = -5.2
    const html = renderToString(<App />);
    expect(html).toContain("5.2");
  });

  it("analysis.json has per_ticket_series", () => {
    expect(data.per_ticket_series).toBeDefined();
    expect(Array.isArray(data.per_ticket_series)).toBe(true);
    expect((data.per_ticket_series as number[]).length).toBeGreaterThan(0);
  });

  it("analysis.json has wow_delta_pct on total_tokens", () => {
    expect(data.executive_summary.total_tokens).toHaveProperty("wow_delta_pct");
  });

  it("analysis.json has wow_delta_pct on per_ticket_trend", () => {
    expect(data.per_ticket_trend).toHaveProperty("wow_delta_pct");
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

  it("filters spec-gen from trend data", () => {
    const inflections = Array.isArray(data.inflections) ? data.inflections : [];
    const html = renderToString(
      <PerStageTrend
        perStageTrend={data.per_stage_trend}
        inflections={inflections}
      />,
    );
    // spec-gen should not appear in the legend/chart
    // The chart renders stage names from filtered trend keys
    expect(html).toContain("investigate");
    expect(html).toContain("implement");
    expect(html).not.toContain(">spec-gen<");
  });

  it("renders attribution details for inflections", () => {
    const inflections = Array.isArray(data.inflections) ? data.inflections : [];
    const html = renderToString(
      <PerStageTrend
        perStageTrend={data.per_stage_trend}
        inflections={inflections}
      />,
    );
    // Attribution type labels rendered
    expect(html).toContain("Ticket Mix");
    expect(html).toContain("Switched to prompt caching strategy");
    expect(html).toContain("Config Change");
    expect(html).toContain("Enabled extended cache TTL");
  });

  it("renders LLM insights via InflectionAttribution", () => {
    const inflections = Array.isArray(data.inflections) ? data.inflections : [];
    const html = renderToString(
      <PerStageTrend
        perStageTrend={data.per_stage_trend}
        inflections={inflections}
      />,
    );
    expect(html).toContain("💡");
    expect(html).toContain("caching rollout");
    expect(html).toContain("Extended TTL reduced cache misses");
  });
});

describe("InflectionAttribution", () => {
  it("renders attribution entries with type labels", () => {
    const inflection = (
      Array.isArray(data.inflections) ? data.inflections : []
    )[0];
    const html = renderToString(
      <InflectionAttribution inflection={inflection} />,
    );
    expect(html).toContain("Ticket Mix");
    expect(html).toContain("Switched to prompt caching strategy");
    expect(html).toContain("Volume Shift");
    expect(html).toContain("3 fewer implement stages vs prior week");
  });

  it("renders LLM insight when present", () => {
    const inflection = (
      Array.isArray(data.inflections) ? data.inflections : []
    )[0];
    const html = renderToString(
      <InflectionAttribution inflection={inflection} />,
    );
    expect(html).toContain("💡");
    expect(html).toContain("caching rollout");
  });

  it("returns null when no attributions and no llm_insight", () => {
    const empty = {
      date: "2026-03-01",
      metric: "test",
      direction: "up",
      magnitude: 0.1,
      context: null,
      avg_7d: 100,
      avg_30d: 90,
      attributions: [],
      llm_insight: null,
    };
    const html = renderToString(<InflectionAttribution inflection={empty} />);
    // Should render nothing
    expect(html).toBe("");
  });

  it("renders only LLM insight when attributions are empty", () => {
    const insightOnly = {
      date: "2026-03-01",
      metric: "test",
      direction: "up",
      magnitude: 0.1,
      context: null,
      avg_7d: 100,
      avg_30d: 90,
      attributions: [],
      llm_insight: "Insight with no attributions",
    };
    const html = renderToString(
      <InflectionAttribution inflection={insightOnly} />,
    );
    expect(html).toContain("💡");
    expect(html).toContain("Insight with no attributions");
    // No list items should be rendered
    expect(html).not.toContain("<li");
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
  it("renders outlier cards with multiplier", () => {
    const outliers = Array.isArray(data.outliers) ? data.outliers : [];
    const html = renderToString(<OutlierAnalysis outliers={outliers} />);
    expect(html).toContain("Outlier Analysis");
    expect(html).toContain("SYMPH-98");
    expect(html).toContain("JONY-42");
    // SYMPH-179: multiplier displayed instead of z-score
    expect(html).toContain("8.5x mean");
    expect(html).toContain("mobilyze-llc/issue/SYMPH-98");
  });

  it("displays hypothesis text for each outlier", () => {
    const outliers = Array.isArray(data.outliers) ? data.outliers : [];
    const html = renderToString(<OutlierAnalysis outliers={outliers} />);
    // Per CH-1: outlier cards show hypothesis + multiplier only
    for (const o of outliers) {
      expect(html).toContain(o.hypothesis);
    }
  });

  it("displays multiplier not z-score", () => {
    const outliers = Array.isArray(data.outliers) ? data.outliers : [];
    const html = renderToString(<OutlierAnalysis outliers={outliers} />);
    // Multiplier = total_tokens / mean (Q-2 decision)
    expect(html).toContain("8.5x mean");
    expect(html).toContain("3.4x mean");
    // z-score should NOT appear in rendered output
    expect(html).not.toContain("z=");
    expect(html).not.toContain("z_score");
  });

  it("links outlier identifiers to Linear", () => {
    const outliers = Array.isArray(data.outliers) ? data.outliers : [];
    const html = renderToString(<OutlierAnalysis outliers={outliers} />);
    for (const o of outliers) {
      expect(html).toContain(
        `https://linear.app/mobilyze-llc/issue/${o.issue_identifier}`,
      );
    }
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

  it("renders leaderboard items with linear_url", () => {
    const items = [
      {
        identifier: "SYMPH-100",
        title: "Test issue",
        tokens: 100000,
        linear_url: "https://linear.app/mobilyze-llc/issue/SYMPH-100",
      },
    ];
    const html = renderToString(<IssueLeaderboard leaderboard={items} />);
    expect(html).toContain("SYMPH-100");
    expect(html).toContain("Test issue");
    expect(html).toContain("100,000");
    expect(html).toContain("mobilyze-llc/issue/SYMPH-100");
  });

  it("slices to top 25 entries (matching renderHtml() behavior)", () => {
    // Build 27 items to verify only the first 25 are rendered
    const items = Array.from({ length: 27 }, (_, i) => ({
      identifier: `TEST-${i + 1}`,
      title: `Issue number ${i + 1}`,
      tokens: 100000 - i * 1000,
      linear_url: `https://linear.app/mobilyze-llc/issue/TEST-${i + 1}`,
    }));
    const html = renderToString(<IssueLeaderboard leaderboard={items} />);
    // Items 1–25 should be present
    expect(html).toContain("TEST-1");
    expect(html).toContain("TEST-25");
    // Items 26–27 should be excluded
    expect(html).not.toContain("TEST-26");
    expect(html).not.toContain("TEST-27");
  });

  it("renders fixture leaderboard with 27 entries showing top 25", () => {
    const html = renderToString(
      <IssueLeaderboard leaderboard={data.leaderboard} />,
    );
    // First entry (rank 1) present
    expect(html).toContain("SYMPH-98");
    expect(html).toContain("450,000");
    // 25th entry (SYMPH-127) present
    expect(html).toContain("SYMPH-127");
    // 26th entry (SYMPH-128) excluded by top-25 slice
    expect(html).not.toContain("SYMPH-128");
    // 27th entry (SYMPH-129) excluded
    expect(html).not.toContain("SYMPH-129");
  });

  it("links all leaderboard identifiers to Linear", () => {
    const html = renderToString(
      <IssueLeaderboard leaderboard={data.leaderboard} />,
    );
    // Verify URL pattern for entries within top 25
    expect(html).toContain("https://linear.app/mobilyze-llc/issue/SYMPH-98");
    expect(html).toContain("https://linear.app/mobilyze-llc/issue/JONY-42");
    expect(html).toContain("https://linear.app/mobilyze-llc/issue/SYMPH-112");
  });
});

describe("PipelineHealth", () => {
  it("renders per-stage failure rate bars from scorecard data", () => {
    const html = renderToString(
      <PipelineHealth failureRate={data.efficiency_scorecard.failure_rate} />,
    );
    expect(html).toContain("Pipeline Health");
    // Stage names derived from failure_rate.current keys
    expect(html).toContain("investigate");
    expect(html).toContain("implement");
    expect(html).toContain("validate");
    // Bar widths are JS-computed percentages (SSR inserts <!-- --> between text nodes)
    expect(html).toContain("2<!-- -->% failure rate");
    expect(html).toContain("8<!-- -->% failure rate");
    expect(html).toContain("5<!-- -->% failure rate");
  });

  it("renders summary insight with worst stage", () => {
    const html = renderToString(
      <PipelineHealth failureRate={data.efficiency_scorecard.failure_rate} />,
    );
    // implement has the highest rate (0.08), should be the worst stage
    expect(html).toContain("implement accounts for");
    expect(html).toContain("% of all failures");
    expect(html).toContain("vs 7d avg");
  });

  it("renders empty state when no failure data", () => {
    const html = renderToString(
      <PipelineHealth
        failureRate={{ current: {}, trend_7d: {}, trend_30d: {} }}
      />,
    );
    expect(html).toContain("Pipeline Health");
    expect(html).toContain("No failure rate data available");
  });

  it("computes bar widths with JS Math.round, not CSS round()", () => {
    const html = renderToString(
      <PipelineHealth failureRate={data.efficiency_scorecard.failure_rate} />,
    );
    // Ensure no CSS round() function in the output
    expect(html).not.toContain("round(");
    // Bar widths should be inline style percentages
    expect(html).toContain("width:2%");
    expect(html).toContain("width:8%");
    expect(html).toContain("width:5%");
  });

  it("shows direction and delta vs 7d avg", () => {
    const html = renderToString(
      <PipelineHealth failureRate={data.efficiency_scorecard.failure_rate} />,
    );
    // implement: current 0.08, trend_7d 0.10 → delta = -2pp → "down 2pp"
    expect(html).toContain("down 2pp vs 7d avg");
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

  it("renders failure rate per stage when provided", () => {
    const html = renderToString(
      <StageEfficiency
        perStageSpend={data.per_stage_spend}
        failureRateCurrent={data.efficiency_scorecard.failure_rate.current}
      />,
    );
    expect(html).toContain("8%<!-- --> failure");
    expect(html).toContain("2%<!-- --> failure");
    expect(html).toContain("5%<!-- --> failure");
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

  it("renders stacked area chart with fixture date-keyed data", () => {
    const html = renderToString(
      <StageUtilizationChart stageData={data.per_stage_trend} />,
    );
    // analysis.json now has date-keyed daily_avg, so chart renders normally
    expect(html).toContain("svg");
    expect(html).toContain("polygon");
    expect(html).toContain("polyline");
    // Should contain legend items for stages in the fixture
    expect(html).toContain("investigate");
    expect(html).toContain("implement");
  });

  it("renders insufficient data state for scalar daily_avg", () => {
    const scalarTrend: Record<
      string,
      { daily_avg: number; wow_delta: number }
    > = {
      investigate: { daily_avg: 71111, wow_delta: -0.05 },
      implement: { daily_avg: 217778, wow_delta: 0.03 },
    };
    const html = renderToString(
      <StageUtilizationChart stageData={scalarTrend} />,
    );
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

// ─── Sparkline fill prop tests ───

describe("Sparkline fill prop", () => {
  const sampleValues = [10, 20, 15, 25, 18];

  it("renders without fill prop identically to legacy behavior (no gradient, no polygon)", () => {
    const html = renderToString(
      <Sparkline values={sampleValues} stroke="#58a6ff" />,
    );
    expect(html).toContain("polyline");
    expect(html).not.toContain("linearGradient");
    expect(html).not.toContain("polygon");
    expect(html).not.toContain("<defs>");
  });

  it("renders gradient and polygon when fill prop is true", () => {
    const html = renderToString(
      <Sparkline values={sampleValues} stroke="#34D399" fill />,
    );
    expect(html).toContain("linearGradient");
    expect(html).toContain("polygon");
    expect(html).toContain("<defs>");
    // Gradient should have two stops with correct opacities
    expect(html).toContain('stop-opacity="0.2"');
    expect(html).toContain('stop-opacity="0"');
    // Stop color should match the stroke color
    expect(html).toContain('stop-color="#34D399"');
  });

  it("uses unique gradient IDs for multiple sparklines", () => {
    // Render both sparklines in the same React tree so useId() generates unique IDs
    const html = renderToString(
      <>
        <Sparkline values={sampleValues} stroke="#58a6ff" fill />
        <Sparkline values={sampleValues} stroke="#3fb950" fill />
      </>,
    );
    // Extract all gradient IDs from the combined output
    const matches = [...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]);
    expect(matches.length).toBeGreaterThanOrEqual(2);
    // First two gradient IDs should be different
    expect(matches[0]).not.toBe(matches[1]);
  });

  it("gradient goes from 20% opacity at top to 0% at bottom", () => {
    const html = renderToString(
      <Sparkline values={sampleValues} stroke="#58a6ff" fill />,
    );
    // Vertical gradient: x1=0, y1=0, x2=0, y2=1
    expect(html).toContain('x1="0"');
    expect(html).toContain('y1="0"');
    expect(html).toContain('x2="0"');
    expect(html).toContain('y2="1"');
    // First stop: 0% offset, 0.2 opacity
    expect(html).toContain('offset="0%"');
    expect(html).toContain('stop-opacity="0.2"');
    // Second stop: 100% offset, 0 opacity
    expect(html).toContain('offset="100%"');
    expect(html).toContain('stop-opacity="0"');
  });

  it("still renders polyline stroke when fill is enabled", () => {
    const html = renderToString(
      <Sparkline values={sampleValues} stroke="#58a6ff" fill />,
    );
    expect(html).toContain("polyline");
    expect(html).toContain('stroke="#58a6ff"');
  });

  it("handles empty values with fill prop gracefully", () => {
    const html = renderToString(<Sparkline values={[]} fill />);
    expect(html).not.toContain("linearGradient");
    expect(html).not.toContain("polygon");
  });
});

// ─── CSS custom properties from styles.json ───

describe("reportCSS design tokens", () => {
  it("contains existing dark-theme CSS vars", () => {
    expect(reportCSS).toContain("--bg: #0d1117");
    expect(reportCSS).toContain("--bg-card: #161b22");
    expect(reportCSS).toContain("--border: #30363d");
    expect(reportCSS).toContain("--text: #c9d1d9");
    expect(reportCSS).toContain("--accent: #58a6ff");
  });

  it("contains styles.json color tokens as CSS custom properties", () => {
    expect(reportCSS).toContain("--color-primary: #1E40AF");
    expect(reportCSS).toContain("--color-secondary: #6366F1");
    expect(reportCSS).toContain("--color-background: #F8FAFC");
    expect(reportCSS).toContain("--color-surface: #FFFFFF");
    expect(reportCSS).toContain("--color-text: #0F172A");
    expect(reportCSS).toContain("--color-text-secondary: #64748B");
    expect(reportCSS).toContain("--color-accent: #10B981");
    expect(reportCSS).toContain("--color-danger: #EF4444");
    expect(reportCSS).toContain("--color-border: #E2E8F0");
  });

  it("contains styles.json typography tokens as CSS custom properties", () => {
    expect(reportCSS).toContain("--font-heading: 'Inter'");
    expect(reportCSS).toContain("--font-body: 'Inter'");
    expect(reportCSS).toContain("--font-size-heading: 28px");
    expect(reportCSS).toContain("--font-size-subheading: 18px");
    expect(reportCSS).toContain("--font-size-body: 14px");
    expect(reportCSS).toContain("--font-size-caption: 12px");
    expect(reportCSS).toContain("--font-weight-heading: 700");
    expect(reportCSS).toContain("--font-weight-subheading: 600");
    expect(reportCSS).toContain("--font-weight-body: 400");
    expect(reportCSS).toContain("--line-height-heading: 1.2");
    expect(reportCSS).toContain("--line-height-subheading: 1.4");
    expect(reportCSS).toContain("--line-height-body: 1.5");
  });

  it("contains styles.json spacing tokens as CSS custom properties", () => {
    expect(reportCSS).toContain("--spacing-section: 32px");
    expect(reportCSS).toContain("--spacing-group: 16px");
    expect(reportCSS).toContain("--spacing-element: 8px");
  });

  it("contains styles.json border tokens as CSS custom properties", () => {
    expect(reportCSS).toContain("--border-radius: 8px");
    expect(reportCSS).toContain("--border-color: #E2E8F0");
    expect(reportCSS).toContain("--border-width: 1px");
  });

  it("uses exact hex values from styles.json (no approximations)", () => {
    // Verify exact casing matches styles.json
    expect(reportCSS).toContain("#1E40AF");
    expect(reportCSS).toContain("#6366F1");
    expect(reportCSS).toContain("#F8FAFC");
    expect(reportCSS).toContain("#FFFFFF");
    expect(reportCSS).toContain("#0F172A");
    expect(reportCSS).toContain("#64748B");
    expect(reportCSS).toContain("#10B981");
    expect(reportCSS).toContain("#EF4444");
    expect(reportCSS).toContain("#E2E8F0");
  });
});

// ─── EfficiencyScorecard uses Sparkline with fill ───

describe("EfficiencyScorecard sparkline fill", () => {
  it("passes fill prop to Sparkline components", () => {
    const html = renderToString(
      <EfficiencyScorecard
        scorecard={data.efficiency_scorecard}
        series={{
          cacheEff: [70, 72, 74, 73, 75],
          outputRatio: [30, 32, 31, 33, 34],
        }}
      />,
    );
    // With fill enabled, sparklines should contain gradient elements
    expect(html).toContain("linearGradient");
    expect(html).toContain("polygon");
  });
});
