/**
 * Shared SVG chart utilities for the Token Report v2 design reference.
 * Converted from sparklineSvg() and multiLineSvg() in ops/token-report.mjs.
 *
 * These are pure presentation helpers — no data fetching or analysis logic.
 */
import React from "react";

/**
 * Round a number to the specified decimal places.
 */
function round(n, decimals = 0) {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

/**
 * Format a number with thousands separators.
 */
export function fmtNum(n) {
  if (n == null || Number.isNaN(n)) return "—";
  return Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
}

/**
 * Render a WoW delta badge as a colored span.
 */
export function WowBadge({ delta }) {
  if (delta == null) {
    return <span style={{ color: "#8b949e" }}>—</span>;
  }
  const sign = delta > 0 ? "+" : "";
  const color = delta > 0 ? "#f85149" : delta < 0 ? "#3fb950" : "#8b949e";
  return (
    <span style={{ color, fontSize: "0.85em" }}>
      {sign}
      {delta}% WoW
    </span>
  );
}

/**
 * Inline SVG sparkline from an array of numeric values.
 * Converted from sparklineSvg() in token-report.mjs:1238–1259.
 */
export function Sparkline({
  values,
  width = 120,
  height = 30,
  stroke = "#58a6ff",
  strokeWidth = 1.5,
}) {
  if (!values || values.length < 2) {
    return (
      <svg
        width={width}
        height={height}
        xmlns="http://www.w3.org/2000/svg"
      />
    );
  }
  const minY = Math.min(...values);
  const maxY = Math.max(...values);
  const rangeY = maxY - minY || 1;
  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * width;
      const y = height - ((v - minY) / rangeY) * (height - 4) - 2;
      return `${round(x, 1)},${round(y, 1)}`;
    })
    .join(" ");

  return (
    <svg width={width} height={height} xmlns="http://www.w3.org/2000/svg">
      <polyline
        points={points}
        fill="none"
        stroke={stroke}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/**
 * Multi-line SVG chart for per-stage trends.
 * Converted from multiLineSvg() in token-report.mjs:1264–1355.
 */
export function MultiLineChart({
  stageData,
  configChanges,
  width = 600,
  height = 200,
}) {
  const colors = [
    "#58a6ff",
    "#3fb950",
    "#d29922",
    "#f85149",
    "#bc8cff",
    "#79c0ff",
    "#56d364",
    "#e3b341",
  ];

  const allDates = new Set();
  for (const stage of Object.keys(stageData)) {
    for (const d of Object.keys(stageData[stage].daily_avg ?? {})) {
      allDates.add(d);
    }
  }
  const sortedDates = [...allDates].sort();

  if (sortedDates.length < 2) {
    return (
      <svg width={width} height={height} xmlns="http://www.w3.org/2000/svg">
        <text x="10" y="20" fill="#8b949e" fontSize="12">
          Insufficient data for trend chart
        </text>
      </svg>
    );
  }

  const stages = Object.keys(stageData);
  const allVals = [];
  for (const stage of stages) {
    const avg = stageData[stage].daily_avg ?? {};
    for (const d of sortedDates) {
      if (avg[d] != null) allVals.push(avg[d]);
    }
  }

  const minY = Math.min(...allVals, 0);
  const maxY = Math.max(...allVals, 1);
  const rangeY = maxY - minY || 1;
  const padL = 50;
  const padR = 10;
  const padT = 10;
  const padB = 25;
  const chartW = width - padL - padR;
  const chartH = height - padT - padB;

  // Grid lines
  const gridLines = [];
  for (let i = 0; i <= 4; i++) {
    const y = padT + (chartH / 4) * i;
    const val = maxY - (rangeY / 4) * i;
    gridLines.push(
      <React.Fragment key={`grid-${i}`}>
        <line
          x1={padL}
          y1={y}
          x2={width - padR}
          y2={y}
          stroke="#21262d"
          strokeWidth="1"
        />
        <text
          x={padL - 5}
          y={y + 4}
          fill="#8b949e"
          fontSize="10"
          textAnchor="end"
        >
          {fmtNum(val)}
        </text>
      </React.Fragment>,
    );
  }

  // Config change markers
  const markers = (configChanges ?? []).map((cc) => {
    const idx = sortedDates.indexOf(cc.date);
    if (idx < 0) return null;
    const x = padL + (idx / (sortedDates.length - 1)) * chartW;
    return (
      <React.Fragment key={`cc-${cc.date}`}>
        <line
          x1={x}
          y1={padT}
          x2={x}
          y2={padT + chartH}
          stroke="#d29922"
          strokeWidth="1"
          strokeDasharray="4,4"
        />
        <text x={x} y={padT - 2} fill="#d29922" fontSize="9" textAnchor="middle">
          ⚙
        </text>
      </React.Fragment>
    );
  });

  // Stage polylines
  const lines = stages.map((stage, si) => {
    const avg = stageData[stage].daily_avg ?? {};
    const pts = [];
    for (const d of sortedDates) {
      if (avg[d] != null) {
        const x =
          padL + (sortedDates.indexOf(d) / (sortedDates.length - 1)) * chartW;
        const y = padT + chartH - ((avg[d] - minY) / rangeY) * chartH;
        pts.push(`${round(x, 1)},${round(y, 1)}`);
      }
    }
    if (pts.length <= 1) return null;
    const color = colors[si % colors.length];
    return (
      <polyline
        key={`line-${stage}`}
        points={pts.join(" ")}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    );
  });

  // Legend
  const legend = stages.map((stage, si) => {
    const x = padL + si * 100;
    const color = colors[si % colors.length];
    return (
      <React.Fragment key={`legend-${stage}`}>
        <rect x={x} y={height - 15} width="10" height="10" fill={color} rx="2" />
        <text x={x + 14} y={height - 6} fill="#c9d1d9" fontSize="10">
          {stage}
        </text>
      </React.Fragment>
    );
  });

  return (
    <svg
      width={width}
      height={height}
      xmlns="http://www.w3.org/2000/svg"
      style={{ background: "#0d1117", borderRadius: "6px" }}
    >
      {gridLines}
      {markers}
      {lines}
      {legend}
    </svg>
  );
}
