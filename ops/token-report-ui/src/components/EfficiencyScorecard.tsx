/**
 * Section 2: Efficiency Scorecard
 * Converted from design reference EfficiencyScorecard.jsx.
 *
 * Note: Failure Rate row removed — now displayed in PipelineHealth component.
 */
import type {
  EfficiencyScorecard as EfficiencyScorecardData,
  MetricWithTrend,
} from "../types.ts";
import { Sparkline, fmtNum } from "./chartUtils.tsx";

function round(n: number, decimals = 0): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

/**
 * Format a metric value as a percentage string (SYMPH-189).
 * Most scorecard metrics are stored as decimals (0.72 = 72%);
 * `tokens_per_turn` is an integer and `first_pass_rate` is already a percentage.
 */
function formatPct(value: number, isRawPct: boolean): string {
  if (isRawPct) return `${round(value, 1)}%`;
  return `${round(value * 100, 1)}%`;
}

export interface ScorecardSeries {
  cacheEff?: number[];
  outputRatio?: number[];
  wastedCtx?: number[];
  tokPerTurn?: number[];
  firstPass?: number[];
}

export interface EfficiencyScorecardProps {
  scorecard: EfficiencyScorecardData;
  series?: ScorecardSeries;
  coldStart?: boolean;
}

/**
 * Build range text: "30d: {formatPct(trend_30d)} → {formatPct(current)}" (SYMPH-189).
 */
function rangeText(
  metric: MetricWithTrend | undefined,
  isRawPct: boolean,
  isTokenCount?: boolean,
): string | null {
  if (!metric || metric.trend_30d == null || metric.current == null)
    return null;
  if (isTokenCount) {
    return `30d: ${fmtNum(metric.trend_30d)} → ${fmtNum(metric.current)}`;
  }
  return `30d: ${formatPct(metric.trend_30d, isRawPct)} → ${formatPct(metric.current, isRawPct)}`;
}

export default function EfficiencyScorecard({
  scorecard,
  series,
  coldStart,
}: EfficiencyScorecardProps) {
  const sc = scorecard ?? ({} as Partial<EfficiencyScorecardData>);
  const s = series ?? {};

  const rows = [
    {
      name: "Cache Efficiency",
      value: `${round(sc.cache_efficiency?.current ?? 0, 1)}%`,
      sparkline: s.cacheEff,
      stroke: "#58a6ff",
      range: rangeText(sc.cache_efficiency, false),
    },
    {
      name: "Output Ratio",
      value: `${round(sc.output_ratio?.current ?? 0, 1)}%`,
      sparkline: s.outputRatio,
      stroke: "#3fb950",
      range: rangeText(sc.output_ratio, false),
    },
    {
      name: "Wasted Context",
      value: `${round(sc.wasted_context?.current ?? 0, 1)}%`,
      sparkline: s.wastedCtx,
      stroke: "#d29922",
      range: rangeText(sc.wasted_context, false),
    },
    {
      name: "Tokens / Turn",
      value: fmtNum(sc.tokens_per_turn?.current ?? 0),
      sparkline: s.tokPerTurn,
      stroke: "#bc8cff",
      range: rangeText(sc.tokens_per_turn, false, true),
    },
    {
      name: "First-Pass Rate",
      value: `${round(sc.first_pass_rate?.current ?? 0, 1)}%`,
      sparkline: s.firstPass,
      stroke: "#56d364",
      range: rangeText(sc.first_pass_rate, true),
    },
  ];

  return (
    <section>
      <h2>Efficiency Scorecard</h2>
      {coldStart && (
        <div
          className="cold-start-scorecard-note"
          style={{
            color: "var(--text-muted)",
            fontSize: "0.85rem",
            marginBottom: "12px",
            fontStyle: "italic",
          }}
        >
          Trend data unavailable — requires 7+ days of history
        </div>
      )}
      {rows.map((row) => (
        <div className="metric-row" key={row.name}>
          <span className="metric-name">{row.name}</span>
          <span className="metric-value">{row.value}</span>
          {row.range && (
            <span
              className="metric-range"
              style={{
                color: "var(--text-muted)",
                fontSize: "0.8rem",
                marginLeft: "8px",
              }}
            >
              {row.range}
            </span>
          )}
          <span className="metric-sparkline">
            <Sparkline values={row.sparkline} stroke={row.stroke} fill />
          </span>
        </div>
      ))}
    </section>
  );
}
