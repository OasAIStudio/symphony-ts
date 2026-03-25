/**
 * Shared SVG chart utilities for the Token Report v2.
 * Converted from chartUtils.jsx design reference.
 */
import type { StageTrend } from "../types.ts";

function round(n: number, decimals = 0): number {
  const f = 10 ** decimals;
  return Math.round(n * f) / f;
}

/**
 * Format a number with thousands separators.
 */
export function fmtNum(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "\u2014";
  return Number(n).toLocaleString("en-US", { maximumFractionDigits: 0 });
}

/**
 * Render a WoW delta badge as a colored span.
 */
export interface WowBadgeProps {
  delta: number | null | undefined;
}

export function WowBadge({ delta }: WowBadgeProps) {
  if (delta == null) {
    return <span style={{ color: "#8b949e" }}>{"\u2014"}</span>;
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
 */
export interface SparklineProps {
  values?: number[];
  width?: number;
  height?: number;
  stroke?: string;
  strokeWidth?: number;
}

export function Sparkline({
  values,
  width = 120,
  height = 30,
  stroke = "#58a6ff",
  strokeWidth = 1.5,
}: SparklineProps) {
  if (!values || values.length < 2) {
    return (
      <svg
        width={width}
        height={height}
        xmlns="http://www.w3.org/2000/svg"
        aria-label="Sparkline chart"
        role="img"
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
    <svg
      width={width}
      height={height}
      xmlns="http://www.w3.org/2000/svg"
      aria-label="Sparkline chart"
      role="img"
    >
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
 */
export interface ConfigChange {
  date: string;
}

export interface MultiLineChartProps {
  stageData: Record<string, StageTrend>;
  configChanges?: ConfigChange[];
  width?: number;
  height?: number;
}

export function MultiLineChart({
  stageData,
  configChanges,
  width = 600,
  height = 200,
}: MultiLineChartProps) {
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

  const allDates = new Set<string>();
  for (const stage of Object.keys(stageData)) {
    const avg = stageData[stage].daily_avg;
    if (typeof avg === "object" && avg !== null && !Array.isArray(avg)) {
      for (const d of Object.keys(avg)) {
        allDates.add(d);
      }
    }
  }
  const sortedDates = [...allDates].sort();

  if (sortedDates.length < 2) {
    return (
      <svg
        width={width}
        height={height}
        xmlns="http://www.w3.org/2000/svg"
        aria-label="Insufficient data for trend chart"
        role="img"
      >
        <text x="10" y="20" fill="#8b949e" fontSize="12">
          Insufficient data for trend chart
        </text>
      </svg>
    );
  }

  const stages = Object.keys(stageData);
  const allVals: number[] = [];
  for (const stage of stages) {
    const avg = stageData[stage].daily_avg;
    if (typeof avg === "object" && avg !== null) {
      for (const d of sortedDates) {
        const val = (avg as Record<string, number>)[d];
        if (val != null) allVals.push(val);
      }
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
      <g key={`grid-${i}`}>
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
      </g>,
    );
  }

  // Config change markers
  const markers = (configChanges ?? []).map((cc) => {
    const idx = sortedDates.indexOf(cc.date);
    if (idx < 0) return null;
    const x = padL + (idx / (sortedDates.length - 1)) * chartW;
    return (
      <g key={`cc-${cc.date}`}>
        <line
          x1={x}
          y1={padT}
          x2={x}
          y2={padT + chartH}
          stroke="#d29922"
          strokeWidth="1"
          strokeDasharray="4,4"
        />
        <text
          x={x}
          y={padT - 2}
          fill="#d29922"
          fontSize="9"
          textAnchor="middle"
        >
          {"\u2699"}
        </text>
      </g>
    );
  });

  // Stage polylines
  const lines = stages.map((stage, si) => {
    const avg = stageData[stage].daily_avg;
    if (typeof avg !== "object" || avg === null) return null;
    const avgObj = avg as Record<string, number>;
    const pts: string[] = [];
    for (const d of sortedDates) {
      if (avgObj[d] != null) {
        const x =
          padL + (sortedDates.indexOf(d) / (sortedDates.length - 1)) * chartW;
        const y = padT + chartH - ((avgObj[d] - minY) / rangeY) * chartH;
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
      <g key={`legend-${stage}`}>
        <rect
          x={x}
          y={height - 15}
          width="10"
          height="10"
          fill={color}
          rx="2"
        />
        <text x={x + 14} y={height - 6} fill="#c9d1d9" fontSize="10">
          {stage}
        </text>
      </g>
    );
  });

  return (
    <svg
      width={width}
      height={height}
      xmlns="http://www.w3.org/2000/svg"
      style={{ background: "#0d1117", borderRadius: "6px" }}
      aria-label="Per-stage token trend chart"
      role="img"
    >
      {gridLines}
      {markers}
      {lines}
      {legend}
    </svg>
  );
}
