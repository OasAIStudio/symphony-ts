/**
 * Section 7: Stage Efficiency — v5 design reference
 * Source of truth for inline styles. Mechanically convert to TypeScript.
 *
 * Props:
 *   - perStageSpend: object keyed by stage name → { total_tokens, count, completed, failed }
 *   - stageSparklines: object keyed by stage name → number[] (30d daily values)
 *   - failureRateCurrent: object keyed by stage name → number (0–1)
 */
import React from "react";
import { fmtNum, Sparkline } from "./chartUtils.jsx";

export default function StageEfficiency({
  perStageSpend,
  stageSparklines,
  failureRateCurrent,
}) {
  const spend = perStageSpend ?? {};
  const sparklines = stageSparklines ?? {};
  const failRates = failureRateCurrent ?? {};

  return (
    <section style={{ marginBottom: "var(--spacing-section)" }}>
      <h2
        style={{
          fontFamily: "var(--font-heading)",
          fontSize: "var(--font-size-subheading)",
          fontWeight: "var(--font-weight-subheading)",
          lineHeight: "var(--line-height-heading)",
          color: "var(--color-text)",
          margin: 0,
          marginBottom: "var(--spacing-group)",
        }}
      >
        Stage Efficiency
      </h2>
      {Object.entries(spend).map(([stage, data]) => {
        const rate = failRates[stage];
        const ratePct = rate != null ? `${Math.round(rate * 100)}%` : null;
        return (
          <div
            key={stage}
            style={{
              display: "flex",
              flexDirection: "column",
              padding: "var(--spacing-group)",
              background: "var(--color-surface)",
              border: "var(--border-width) solid var(--border-color)",
              borderRadius: "var(--border-radius)",
              marginBottom: "var(--spacing-element)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: "var(--spacing-element)",
              }}
            >
              <span
                style={{
                  color: "var(--color-text)",
                  fontWeight: "var(--font-weight-subheading)",
                  fontFamily: "var(--font-heading)",
                }}
              >
                {stage}
              </span>
              <span
                style={{
                  color: "var(--color-text-secondary)",
                  fontSize: "var(--font-size-small)",
                }}
              >
                {fmtNum(data.total_tokens)} tokens &middot; {data.count} runs
                &middot; {data.completed} ok &middot; {data.failed} fail
                {ratePct != null && (
                  <>
                    {" "}
                    &middot;{" "}
                    <span style={{ color: "var(--color-danger)" }}>
                      {ratePct} failure
                    </span>
                  </>
                )}
              </span>
            </div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--spacing-element)",
              }}
            >
              <span
                style={{
                  color: "var(--color-text-secondary)",
                  fontSize: "var(--font-size-small)",
                }}
              >
                30d trend:
              </span>
              <Sparkline values={sparklines[stage] ?? []} stroke="#58a6ff" />
            </div>
          </div>
        );
      })}
    </section>
  );
}
