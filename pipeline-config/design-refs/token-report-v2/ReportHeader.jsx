/**
 * Section 0: Report Header
 * Converted from token-report.mjs:1661–1663 (renderHtml header area).
 *
 * Props:
 *   - today: string (formatted date key)
 *   - recordCount: number
 *   - dataSpanDays: number
 */
import React from "react";
import { fmtNum } from "./chartUtils.jsx";

export default function ReportHeader({ today, recordCount, dataSpanDays }) {
  return (
    <header>
      <h1 style={{ color: "var(--text-bright)", marginBottom: "8px", fontSize: "1.5rem" }}>
        Symphony Token Report
      </h1>
      <p
        className="subtitle"
        style={{ color: "var(--text-muted)", fontSize: "0.9rem", marginBottom: "24px" }}
      >
        Generated {today} · {fmtNum(recordCount)} records · {dataSpanDays} day span
      </p>
    </header>
  );
}
