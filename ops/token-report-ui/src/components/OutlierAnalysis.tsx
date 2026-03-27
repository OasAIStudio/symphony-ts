/**
 * Section 5: Outlier Analysis
 * Converted from design reference OutlierAnalysis.jsx.
 *
 * Per CH-1: outlier cards show hypothesis + multiplier only, no per-stage breakdown.
 * SYMPH-179: enriched with multiplier and linear_url from computeAnalysis().
 */
import type { Outlier } from "../types.ts";
import { fmtNum } from "./chartUtils.tsx";

export interface OutlierAnalysisProps {
  outliers: Outlier[];
  coldStart?: boolean;
  dataSpanDays?: number;
}

export default function OutlierAnalysis({
  outliers,
  coldStart,
  dataSpanDays,
}: OutlierAnalysisProps) {
  const items = Array.isArray(outliers) ? outliers : [];

  if (coldStart) {
    return (
      <section>
        <h2>Outlier Analysis</h2>
        <div
          className="cold-start-placeholder"
          style={{
            background: "var(--bg-card)",
            border: "1px dashed var(--border)",
            borderRadius: "6px",
            padding: "24px",
            textAlign: "center",
            color: "var(--text-muted)",
          }}
        >
          <div style={{ fontSize: "1.5rem", marginBottom: "8px" }}>📊</div>
          <div style={{ fontWeight: 500, marginBottom: "4px" }}>
            Collecting data&hellip;
          </div>
          <div style={{ fontSize: "0.85rem" }}>
            Outlier detection requires at least 7 days of data.{" "}
            {dataSpanDays != null && 7 - dataSpanDays > 0 && (
              <>
                {7 - dataSpanDays} more{" "}
                {7 - dataSpanDays === 1 ? "day" : "days"} needed.
              </>
            )}
          </div>
        </div>
      </section>
    );
  }

  if (items.length === 0) {
    return (
      <section>
        <h2>Outlier Analysis</h2>
        <p style={{ color: "var(--text-muted)" }}>
          No outliers detected (&gt;2&sigma; threshold)
        </p>
      </section>
    );
  }

  return (
    <section>
      <h2>Outlier Analysis</h2>
      {items.map((o) => (
        <div className="outlier-card" key={o.issue_identifier}>
          <div className="outlier-title">
            <a href={o.linear_url} target="_blank" rel="noopener noreferrer">
              {o.issue_identifier}
            </a>{" "}
            &mdash; {o.issue_title} &mdash; {fmtNum(o.total_tokens)} tokens (
            {`${o.multiplier}x mean`})
          </div>
          <div className="outlier-hypothesis">
            {o.hypothesis ?? "No hypothesis available"}
          </div>
        </div>
      ))}
    </section>
  );
}
