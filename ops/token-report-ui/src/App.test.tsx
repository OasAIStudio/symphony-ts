import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import App from "./App.tsx";
import analysisData from "./analysis.json";

describe("App", () => {
  it("renders without crashing", () => {
    const html = renderToString(<App />);
    expect(html).toContain("Token Report");
  });

  it("renders executive summary data", () => {
    const html = renderToString(<App />);
    expect(html).toContain("Executive Summary");
    expect(html).toContain("Total tokens");
  });

  it("renders efficiency scorecard", () => {
    const html = renderToString(<App />);
    expect(html).toContain("Efficiency Scorecard");
    expect(html).toContain("Cache efficiency");
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
