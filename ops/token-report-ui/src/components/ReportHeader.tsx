/**
 * Section 0: Report Header
 * Converted from design reference ReportHeader.jsx.
 */
import { fmtNum } from "./chartUtils.tsx";

export interface ReportHeaderProps {
  today: string;
  recordCount: number;
  dataSpanDays: number;
}

export default function ReportHeader({
  today,
  recordCount,
  dataSpanDays,
}: ReportHeaderProps) {
  return (
    <header>
      <h1
        style={{
          color: "var(--text-bright)",
          marginBottom: "8px",
          fontSize: "1.5rem",
        }}
      >
        Symphony Token Report
      </h1>
      <p
        className="subtitle"
        style={{
          color: "var(--text-muted)",
          fontSize: "0.9rem",
          marginBottom: "24px",
        }}
      >
        Generated {today} &middot; {fmtNum(recordCount)} records &middot;{" "}
        {dataSpanDays} day span
      </p>
    </header>
  );
}
