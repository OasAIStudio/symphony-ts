/**
 * Section 5: Outlier Analysis
 * Converted from design reference OutlierAnalysis.jsx.
 *
 * Note: Design ref used issue_identifier/issue_title/total_tokens/hypothesis.
 * analysis.json uses issue/tokens/reason. Adapted to actual data shape.
 */
import type { Outlier } from "../types.ts";
import { fmtNum } from "./chartUtils.tsx";

export interface OutlierAnalysisProps {
  outliers: Outlier[];
}

export default function OutlierAnalysis({ outliers }: OutlierAnalysisProps) {
  const items = Array.isArray(outliers) ? outliers : [];

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
        <div className="outlier-card" key={o.issue}>
          <div className="outlier-title">
            <a
              href={`https://linear.app/issue/${o.issue}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {o.issue}
            </a>{" "}
            &mdash; {o.stage} &mdash; {fmtNum(o.tokens)} tokens (z={o.z_score})
          </div>
          <div className="outlier-hypothesis">
            {o.reason ?? "No hypothesis available"}
          </div>
        </div>
      ))}
    </section>
  );
}
