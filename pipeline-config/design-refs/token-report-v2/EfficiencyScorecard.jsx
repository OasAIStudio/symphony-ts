/**
 * Section 2: Efficiency Scorecard
 * Converted from token-report.mjs:1688–1723 (6 metric rows with sparklines).
 *
 * Props:
 *   - scorecard: { cache_efficiency, output_ratio, wasted_context, tokens_per_turn, first_pass_rate, failure_rate }
 *     Each metric has .current (number). failure_rate.current is an object of stage→rate.
 *   - series: { cacheEff, outputRatio, wastedCtx, tokPerTurn, firstPass, failureRate } — arrays of numbers for sparklines
 */
import React from "react";
import { fmtNum, Sparkline } from "./chartUtils.jsx";

function round(n, decimals = 0) {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

function mean(arr) {
  if (!arr || arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

export default function EfficiencyScorecard({ scorecard, series }) {
  const sc = scorecard ?? {};
  const s = series ?? {};

  const failureRateCurrent = sc.failure_rate?.current ?? {};
  const rates = Object.values(failureRateCurrent);
  const avgFailRate = rates.length > 0 ? `${round(mean(rates), 1)}%` : "0%";

  const rows = [
    {
      name: "Cache Efficiency",
      value: `${round(sc.cache_efficiency?.current ?? 0, 1)}%`,
      sparkline: s.cacheEff,
      stroke: "#58a6ff",
    },
    {
      name: "Output Ratio",
      value: `${round(sc.output_ratio?.current ?? 0, 1)}%`,
      sparkline: s.outputRatio,
      stroke: "#3fb950",
    },
    {
      name: "Wasted Context",
      value: `${round(sc.wasted_context?.current ?? 0, 1)}%`,
      sparkline: s.wastedCtx,
      stroke: "#d29922",
    },
    {
      name: "Tokens / Turn",
      value: fmtNum(sc.tokens_per_turn?.current ?? 0),
      sparkline: s.tokPerTurn,
      stroke: "#bc8cff",
    },
    {
      name: "First-Pass Rate",
      value: `${round(sc.first_pass_rate?.current ?? 0, 1)}%`,
      sparkline: s.firstPass,
      stroke: "#56d364",
    },
    {
      name: "Failure Rate (all stages)",
      value: avgFailRate,
      sparkline: s.failureRate,
      stroke: "#f85149",
    },
  ];

  return (
    <section>
      <h2>Efficiency Scorecard</h2>
      {rows.map((row) => (
        <div className="metric-row" key={row.name}>
          <span className="metric-name">{row.name}</span>
          <span className="metric-value">{row.value}</span>
          <span className="metric-sparkline">
            <Sparkline values={row.sparkline} stroke={row.stroke} />
          </span>
        </div>
      ))}
    </section>
  );
}
