/**
 * Section 4: Per-Ticket Cost Trend
 * Converted from design reference PerTicketCostTrend.jsx.
 * Rebuilt from v5 per-ticket-cost-trend.jsx inline styles (SYMPH-198).
 */
import type { PerTicketTrend } from "../types.ts";
import ColdStartPlaceholder from "./ColdStartPlaceholder.tsx";
import { Sparkline, fmtNum } from "./chartUtils.tsx";

export interface PerTicketCostTrendProps {
  perTicket: PerTicketTrend;
  perTicketSeries?: number[];
  coldStart?: boolean;
  dataSpanDays?: number;
}

export default function PerTicketCostTrend({
  perTicket,
  perTicketSeries,
  coldStart,
  dataSpanDays,
}: PerTicketCostTrendProps) {
  const pt = perTicket ?? ({} as Partial<PerTicketTrend>);

  return (
    <section>
      <h2>Per-Ticket Cost Trend</h2>
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
          <div
            style={{
              marginBottom: "8px",
              color: "var(--text-muted)",
              fontSize: "0.85rem",
            }}
          >
            Rolling median tokens per ticket &middot; median:{" "}
            {fmtNum(pt.median)} &middot; mean: {fmtNum(pt.mean)} &middot;{" "}
            {pt.ticket_count} tickets
          </div>
          <Sparkline
            values={perTicketSeries}
            width={580}
            height={60}
            stroke="#58a6ff"
            strokeWidth={2}
          />
        </div>
      )}
    </section>
  );
}
