/**
 * Section 3: Per-Stage Utilization Trend
 * Converted from design reference PerStageTrend.jsx.
 * Rebuilt from v5 per-stage-utilization-trend.jsx inline styles (SYMPH-198).
 */
import type { Inflection, StageTrend } from "../types.ts";
import ColdStartPlaceholder from "./ColdStartPlaceholder.tsx";
import InflectionAttribution from "./InflectionAttribution.tsx";
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
  // spec-gen exclusion: filter stage_name === "spec-gen" from trend data
  const filteredTrend: Record<string, StageTrend> = {};
  for (const [stage, val] of Object.entries(trend)) {
    if (stage !== "spec-gen") {
      filteredTrend[stage] = val;
    }
  }
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
        <div
          style={{
            background: "var(--bg-card)",
            border: "1px solid var(--border)",
            borderRadius: "6px",
            padding: "16px",
            marginBottom: "16px",
            overflowX: "auto",
          }}
        >
          <MultiLineChart
            stageData={filteredTrend}
            configChanges={configChanges}
          />
          {infl.length > 0 &&
            infl.map((inf) => (
              <div
                key={`${inf.date}-${inf.metric}`}
                style={{
                  background: "rgba(210,153,34,0.1)",
                  border: "1px solid var(--yellow)",
                  borderRadius: "6px",
                  padding: "12px 16px",
                  marginBottom: "12px",
                }}
              >
                <div
                  style={{
                    color: "var(--yellow)",
                    fontWeight: 600,
                    fontSize: "0.85rem",
                  }}
                >
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
                </div>
                <InflectionAttribution inflection={inf} />
              </div>
            ))}
        </div>
      )}
    </section>
  );
}
