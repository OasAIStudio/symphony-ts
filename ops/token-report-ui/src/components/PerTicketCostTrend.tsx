/**
 * Section 4: Per-Ticket Cost Trend
 * Converted from design reference PerTicketCostTrend.jsx.
 */
import type { PerTicketTrend } from "../types.ts";
import { Sparkline, fmtNum } from "./chartUtils.tsx";

export interface PerTicketCostTrendProps {
  perTicket: PerTicketTrend;
  perTicketSeries?: number[];
}

export default function PerTicketCostTrend({
  perTicket,
  perTicketSeries,
}: PerTicketCostTrendProps) {
  const pt = perTicket ?? ({} as Partial<PerTicketTrend>);

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
          Rolling median tokens per ticket &middot; median: {fmtNum(pt.median)}{" "}
          &middot; mean: {fmtNum(pt.mean)} &middot; {pt.ticket_count} tickets
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
