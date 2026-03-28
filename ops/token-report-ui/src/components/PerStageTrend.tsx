/**
 * Section 3: Per-Stage Utilization Trend
 * Converted from design reference PerStageTrend.jsx.
 */
import type { Inflection, StageTrend } from "../types.ts";
import ColdStartPlaceholder from "./ColdStartPlaceholder.tsx";
import { MultiLineChart, fmtNum } from "./chartUtils.tsx";
import type { ConfigChange } from "./chartUtils.tsx";

export interface PerStageTrendProps {
  perStageTrend: Record<string, StageTrend>;
  configChanges?: ConfigChange[];
  inflections?: Inflection[];
  coldStart?: boolean;
  dataSpanDays?: number;
}

export default function PerStageTrend({
  perStageTrend,
  configChanges,
  inflections,
  coldStart,
  dataSpanDays,
}: PerStageTrendProps) {
  const trend = perStageTrend ?? {};
  const infl = Array.isArray(inflections) ? inflections : [];

  return (
    <section>
      <h2>Per-Stage Utilization Trend</h2>
      {coldStart ? (
        <ColdStartPlaceholder
          requiredDays={7}
          currentDays={dataSpanDays ?? 0}
        />
      ) : (
        <div className="chart-container">
          <MultiLineChart stageData={trend} configChanges={configChanges} />
          {infl.length > 0 &&
            infl.map((inf) => (
              <div
                className="inflection-panel"
                key={`${inf.date}-${inf.metric}`}
              >
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
                  7d avg: {fmtNum(inf.avg_7d)} &middot; 30d avg:{" "}
                  {fmtNum(inf.avg_30d)}
                  {inf.context ? ` \u00B7 ${inf.context}` : ""}
                  {inf.llm_insight ? (
                    <div style={{ marginTop: "4px" }}>💡 {inf.llm_insight}</div>
                  ) : null}
                </div>
              </div>
            ))}
        </div>
      )}
    </section>
  );
}
