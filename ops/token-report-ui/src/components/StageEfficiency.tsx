/**
 * Section 7: Stage Efficiency
 * Converted from design reference StageEfficiency.jsx.
 */
import type { StageSpend } from "../types.ts";
import { Sparkline, fmtNum } from "./chartUtils.tsx";

export interface StageEfficiencyProps {
  perStageSpend: Record<string, StageSpend>;
  stageSparklines?: Record<string, number[]>;
}

export default function StageEfficiency({
  perStageSpend,
  stageSparklines,
}: StageEfficiencyProps) {
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
              {fmtNum(data.total_tokens)} tokens &middot; {data.count} runs
              &middot; {data.completed} ok &middot; {data.failed} fail
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
