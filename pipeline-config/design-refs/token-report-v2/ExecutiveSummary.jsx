/**
 * Section 1: Executive Summary
 * Converted from token-report.mjs:1664–1686 (4-card KPI grid).
 *
 * Props:
 *   - totalTokens: number
 *   - tokensDelta: number|null (WoW % change)
 *   - tokensPerIssueMedian: number
 *   - tokensPerIssueMean: number
 *   - tokPerIssueWow: number|null
 *   - uniqueIssues: number
 *   - cacheHitRate: number (percentage)
 *   - cacheWow: number|null
 */
import React from "react";
import { fmtNum, WowBadge } from "./chartUtils.jsx";

function round(n, decimals = 0) {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

export default function ExecutiveSummary({
  totalTokens,
  tokensDelta,
  tokensPerIssueMedian,
  tokensPerIssueMean,
  tokPerIssueWow,
  uniqueIssues,
  cacheHitRate,
  cacheWow,
}) {
  return (
    <section>
      <h2>Executive Summary</h2>
      <div className="kpi-grid">
        <div className="kpi-card">
          <div className="kpi-label">Total Tokens</div>
          <div className="kpi-value">{fmtNum(totalTokens)}</div>
          <div className="kpi-delta">
            <WowBadge delta={tokensDelta} />
          </div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Tokens / Issue (median)</div>
          <div className="kpi-value">{fmtNum(tokensPerIssueMedian)}</div>
          <div className="kpi-delta">
            mean: {fmtNum(tokensPerIssueMean)} <WowBadge delta={tokPerIssueWow} />
          </div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Issues Processed</div>
          <div className="kpi-value">{fmtNum(uniqueIssues)}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Cache Hit Rate</div>
          <div className="kpi-value">{round(cacheHitRate, 1)}%</div>
          <div className="kpi-delta">
            <WowBadge delta={cacheWow} />
          </div>
        </div>
      </div>
    </section>
  );
}
