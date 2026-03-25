/**
 * Section 1: Executive Summary
 * Converted from design reference ExecutiveSummary.jsx.
 */
import { WowBadge, fmtNum } from "./chartUtils.tsx";

function round(n: number, decimals = 0): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

export interface ExecutiveSummaryProps {
  totalTokens: number;
  tokensDelta: number | null;
  tokensPerIssueMedian: number;
  tokensPerIssueMean: number;
  tokPerIssueWow: number | null;
  uniqueIssues: number;
  cacheHitRate: number;
  cacheWow: number | null;
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
}: ExecutiveSummaryProps) {
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
            mean: {fmtNum(tokensPerIssueMean)}{" "}
            <WowBadge delta={tokPerIssueWow} />
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
