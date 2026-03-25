/**
 * Section 3: Per-Stage Utilization Trend
 * Converted from design reference PerStageTrend.jsx.
 */
import type { Inflection, StageTrend } from "../types.ts";
import { MultiLineChart, fmtNum } from "./chartUtils.tsx";
import type { ConfigChange } from "./chartUtils.tsx";

export interface PerStageTrendProps {
  perStageTrend: Record<string, StageTrend>;
  configChanges?: ConfigChange[];
  inflections?: Inflection[];
}

export default function PerStageTrend({
  perStageTrend,
  configChanges,
  inflections,
}: PerStageTrendProps) {
  const trend = perStageTrend ?? {};
  const infl = Array.isArray(inflections) ? inflections : [];

  return (
    <section>
      <h2>Per-Stage Utilization Trend</h2>
      <div className="chart-container">
        <MultiLineChart stageData={trend} configChanges={configChanges} />
        {infl.length > 0 &&
          infl.map((inf) => (
            <div className="inflection-panel" key={`${inf.date}-${inf.metric}`}>
              <div className="label">
                {"\u26A1"} Inflection: {inf.metric ?? ""} &mdash;{" "}
                {inf.direction ?? ""}{" "}
                {inf.magnitude != null
                  ? `${Math.round(inf.magnitude * 100)}%`
                  : ""}
              </div>
              <div
                style={{
                  color: "var(--text-muted)",
                  fontSize: "0.85rem",
                  marginTop: "4px",
                }}
              >
                {inf.date} &middot; {fmtNum(null)}
                {inf.context ? ` \u00B7 ${inf.context}` : ""}
              </div>
            </div>
          ))}
      </div>
    </section>
  );
}
