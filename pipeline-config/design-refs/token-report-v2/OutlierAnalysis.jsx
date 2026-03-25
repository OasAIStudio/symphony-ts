/**
 * Section 5: Outlier Analysis
 * Converted from token-report.mjs:1751–1766.
 *
 * Props:
 *   - outliers: array of {
 *       issue_identifier: string,
 *       issue_title: string,
 *       total_tokens: number,
 *       z_score: number,
 *       hypothesis?: string,
 *       parent?: { identifier: string, complexity: string, task_count: number }
 *     }
 */
import React from "react";
import { fmtNum } from "./chartUtils.jsx";

export default function OutlierAnalysis({ outliers }) {
  const items = Array.isArray(outliers) ? outliers : [];

  if (items.length === 0) {
    return (
      <section>
        <h2>Outlier Analysis</h2>
        <p style={{ color: "var(--text-muted)" }}>
          No outliers detected (&gt;2σ threshold)
        </p>
      </section>
    );
  }

  return (
    <section>
      <h2>Outlier Analysis</h2>
      {items.map((o, i) => (
        <div className="outlier-card" key={i}>
          <div className="outlier-title">
            <a
              href={`https://linear.app/issue/${o.issue_identifier}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {o.issue_identifier}
            </a>
            {" "}— {o.issue_title} — {fmtNum(o.total_tokens)} tokens (z={o.z_score})
          </div>
          <div className="outlier-hypothesis">
            {o.hypothesis ?? "No hypothesis available"}
          </div>
          {o.parent && (
            <div
              style={{
                color: "var(--text-muted)",
                fontSize: "0.85rem",
                marginTop: "4px",
              }}
            >
              Parent: {o.parent.identifier} ({o.parent.complexity}, {o.parent.task_count}{" "}
              tasks)
            </div>
          )}
        </div>
      ))}
    </section>
  );
}
