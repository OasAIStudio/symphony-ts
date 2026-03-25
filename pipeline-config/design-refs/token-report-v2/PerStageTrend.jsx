/**
 * Section 3: Per-Stage Utilization Trend
 * Converted from token-report.mjs:1725–1742.
 *
 * Props:
 *   - perStageTrend: object keyed by stage name, each with { daily_avg: {date: value}, config_changes: [] }
 *   - configChanges: array of { date: string }
 *   - inflections: array of { stage, direction, pct_change, avg_7d, avg_30d, attributions?: [] }
 */
import React from "react";
import { fmtNum, MultiLineChart } from "./chartUtils.jsx";

function escText(str) {
  if (str == null) return "";
  return String(str);
}

export default function PerStageTrend({ perStageTrend, configChanges, inflections }) {
  const trend = perStageTrend ?? {};
  const infl = Array.isArray(inflections) ? inflections : [];

  return (
    <section>
      <h2>Per-Stage Utilization Trend</h2>
      <div className="chart-container">
        <MultiLineChart
          stageData={trend}
          configChanges={configChanges}
        />
        {infl.length > 0 &&
          infl.map((inf, i) => (
            <div className="inflection-panel" key={i}>
              <div className="label">
                ⚡ Inflection: {escText(inf.stage)} — {escText(inf.direction)} {inf.pct_change}%
              </div>
              <div
                style={{
                  color: "var(--text-muted)",
                  fontSize: "0.85rem",
                  marginTop: "4px",
                }}
              >
                7d avg: {fmtNum(inf.avg_7d)} · 30d avg: {fmtNum(inf.avg_30d)}
                {inf.attributions?.length > 0
                  ? ` · ${inf.attributions.map((a) => escText(a.description)).join("; ")}`
                  : ""}
              </div>
            </div>
          ))}
      </div>
    </section>
  );
}
