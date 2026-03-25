/**
 * Barrel export for Token Report v2 React components.
 * Exports all 10 sections, chart utilities, design tokens, and CSS.
 */
export { default as ReportHeader } from "./ReportHeader.tsx";
export { default as ExecutiveSummary } from "./ExecutiveSummary.tsx";
export { default as EfficiencyScorecard } from "./EfficiencyScorecard.tsx";
export { default as PerStageTrend } from "./PerStageTrend.tsx";
export { default as PerTicketCostTrend } from "./PerTicketCostTrend.tsx";
export { default as OutlierAnalysis } from "./OutlierAnalysis.tsx";
export { default as IssueLeaderboard } from "./IssueLeaderboard.tsx";
export { default as StageEfficiency } from "./StageEfficiency.tsx";
export { default as PerProductBreakdown } from "./PerProductBreakdown.tsx";
export { default as ReportFooter } from "./ReportFooter.tsx";
export { fmtNum, WowBadge, Sparkline, MultiLineChart } from "./chartUtils.tsx";

export const designTokens = {
  bg: "#0d1117",
  bgCard: "#161b22",
  border: "#30363d",
  text: "#c9d1d9",
  textMuted: "#8b949e",
  textBright: "#f0f6fc",
  accent: "#58a6ff",
  green: "#3fb950",
  red: "#f85149",
  yellow: "#d29922",
  purple: "#bc8cff",
};

export const reportCSS = `
:root {
  --bg: #0d1117;
  --bg-card: #161b22;
  --border: #30363d;
  --text: #c9d1d9;
  --text-muted: #8b949e;
  --text-bright: #f0f6fc;
  --accent: #58a6ff;
  --green: #3fb950;
  --red: #f85149;
  --yellow: #d29922;
  --purple: #bc8cff;
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.5;
  padding: 24px;
  max-width: 1200px;
  margin: 0 auto;
}
h1 { color: var(--text-bright); margin-bottom: 8px; font-size: 1.5rem; }
h2 {
  color: var(--text-bright);
  font-size: 1.2rem;
  margin: 32px 0 16px;
  padding-bottom: 8px;
  border-bottom: 1px solid var(--border);
}
.subtitle { color: var(--text-muted); font-size: 0.9rem; margin-bottom: 24px; }
.kpi-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
  gap: 16px;
  margin-bottom: 24px;
}
.kpi-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 16px;
}
.kpi-label { color: var(--text-muted); font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; }
.kpi-value { color: var(--text-bright); font-size: 1.6rem; font-weight: 600; margin: 4px 0; }
.kpi-delta { font-size: 0.85rem; }
.metric-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 6px;
  margin-bottom: 8px;
}
.metric-name { color: var(--text); font-weight: 500; min-width: 140px; }
.metric-value { color: var(--text-bright); font-weight: 600; min-width: 60px; text-align: right; }
.metric-sparkline { margin-left: 16px; }
.chart-container {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 16px;
  margin-bottom: 16px;
  overflow-x: auto;
}
table {
  width: 100%;
  border-collapse: collapse;
  margin-bottom: 16px;
}
th {
  text-align: left;
  color: var(--text-muted);
  font-size: 0.8rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
}
td {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  color: var(--text);
}
tr:hover td { background: rgba(88,166,255,0.04); }
.outlier-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 16px;
  margin-bottom: 12px;
}
.outlier-title { color: var(--accent); font-weight: 600; }
.outlier-hypothesis { color: var(--text-muted); font-size: 0.9rem; margin-top: 4px; }
.stage-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 16px;
  margin-bottom: 12px;
}
.stage-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.stage-name { color: var(--text-bright); font-weight: 600; }
.inflection-panel {
  background: rgba(210,153,34,0.1);
  border: 1px solid var(--yellow);
  border-radius: 6px;
  padding: 12px 16px;
  margin-bottom: 12px;
}
.inflection-panel .label { color: var(--yellow); font-weight: 600; font-size: 0.85rem; }
a { color: var(--accent); text-decoration: none; }
a:hover { text-decoration: underline; }
.product-bar {
  height: 8px;
  border-radius: 4px;
  background: var(--accent);
  margin-top: 4px;
}
footer { color: var(--text-muted); font-size: 0.8rem; margin-top: 40px; text-align: center; }
`;
