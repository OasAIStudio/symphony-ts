/**
 * Section 7: Stage Efficiency
 * Converted from token-report.mjs:1783–1799.
 *
 * Props:
 *   - perStageSpend: object keyed by stage name → { total_tokens, count, completed, failed }
 *   - stageSparklines: object keyed by stage name → number[] (30d daily values)
 */
import React from "react";
import { fmtNum, Sparkline } from "./chartUtils.jsx";

export default function StageEfficiency({ perStageSpend, stageSparklines }) {
  const spend = perStageSpend ?? {};
  const sparklines = stageSparklines ?? {};

  return (
    <section>
      <h2>Stage Efficiency</h2>
      {Object.entries(spend).map(([stage, data]) => (
        <div className="stage-card" key={stage}>
          <div className="stage-header">
            <span className="stage-name">{stage}</span>
            <span style={{ color: "var(--text-muted)" }}>
              {fmtNum(data.total_tokens)} tokens · {data.count} runs · {data.completed}{" "}
              ok · {data.failed} fail
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <span
              style={{
                color: "var(--text-muted)",
                fontSize: "0.85rem",
              }}
            >
              30d trend:
            </span>
            <Sparkline values={sparklines[stage] ?? []} stroke="#58a6ff" />
          </div>
        </div>
      ))}
    </section>
  );
}
