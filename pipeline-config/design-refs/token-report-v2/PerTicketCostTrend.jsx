/**
 * Section 4: Per-Ticket Cost Trend
 * Converted from token-report.mjs:1744–1749.
 *
 * Props:
 *   - perTicket: { median: number, mean: number, ticket_count: number }
 *   - perTicketSeries: number[] (rolling median values for sparkline)
 */
import React from "react";
import { fmtNum, Sparkline } from "./chartUtils.jsx";

export default function PerTicketCostTrend({ perTicket, perTicketSeries }) {
  const pt = perTicket ?? {};

  return (
    <section>
      <h2>Per-Ticket Cost Trend</h2>
      <div className="chart-container">
        <div
          style={{
            marginBottom: "8px",
            color: "var(--text-muted)",
            fontSize: "0.85rem",
          }}
        >
          Rolling median tokens per ticket · median: {fmtNum(pt.median)} · mean:{" "}
          {fmtNum(pt.mean)} · {pt.ticket_count} tickets
        </div>
        <Sparkline
          values={perTicketSeries}
          width={580}
          height={60}
          stroke="#58a6ff"
          strokeWidth={2}
        />
      </div>
    </section>
  );
}
