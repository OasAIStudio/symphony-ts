/**
 * StageUtilizationChart — Stacked area/line chart with date X-axis.
 * Shows per-stage token utilization trend over time.
 * Converted from Paper design reference; pure SVG, no external charting libs.
 * Inline styles aligned with v5 per-stage-utilization-trend.jsx (SYMPH-198).
 */
import {
  CHART_TOKENS,
  DEFAULT_PADDING,
  STAGE_COLORS,
  buildPointsString,
  computeYGrid,
  extractSortedDates,
  formatAxisValue,
  formatDateLabel,
  linearScale,
  pickTickIndices,
  round,
} from "../lib/chart-utils.ts";
import type { StageTrend } from "../types.ts";
import type { ConfigChange } from "./chartUtils.tsx";

export interface StageUtilizationChartProps {
  stageData: Record<string, StageTrend>;
  configChanges?: ConfigChange[];
  width?: number;
  height?: number;
}

/**
 * Stacked area/line chart rendering per-stage token utilization over time.
 * Each stage is rendered as a filled area + stroke line, stacked from bottom.
 * Includes date X-axis labels, Y-axis grid, config-change markers, and legend.
 */
export default function StageUtilizationChart({
  stageData,
  configChanges,
  width = 600,
  height = 260,
}: StageUtilizationChartProps) {
  const pad = DEFAULT_PADDING;
  const chartW = width - pad.left - pad.right;
  const chartH = height - pad.top - pad.bottom;

  const sortedDates = extractSortedDates(stageData);

  if (sortedDates.length < 2) {
    return (
      <svg
        width={width}
        height={height}
        xmlns="http://www.w3.org/2000/svg"
        aria-label="Insufficient data for stage utilization chart"
        role="img"
      >
        <text x="10" y="20" fill={CHART_TOKENS.axisText} fontSize="12">
          Insufficient data for stage utilization chart
        </text>
      </svg>
    );
  }

  const stages = Object.keys(stageData);

  // Build per-stage value arrays aligned to sortedDates
  const stageValues: Record<string, number[]> = {};
  for (const stage of stages) {
    const avg = stageData[stage].daily_avg;
    if (typeof avg === "object" && avg !== null && !Array.isArray(avg)) {
      stageValues[stage] = sortedDates.map(
        (d) => (avg as Record<string, number>)[d] ?? 0,
      );
    } else {
      // Scalar daily_avg — fill with constant value
      const val = typeof avg === "number" ? avg : 0;
      stageValues[stage] = sortedDates.map(() => val);
    }
  }

  // Compute stacked values (cumulative sum at each date index)
  const stackedValues: Record<string, number[]> = {};
  const cumulativeBase: number[] = new Array(sortedDates.length).fill(0);
  for (const stage of stages) {
    const vals = stageValues[stage];
    stackedValues[stage] = vals.map((v, i) => cumulativeBase[i] + v);
    // Update base for next stage
    for (let i = 0; i < sortedDates.length; i++) {
      cumulativeBase[i] = stackedValues[stage][i];
    }
  }

  // Y range: 0 to max stacked value
  const maxStackedY = Math.max(...cumulativeBase, 1);
  const minY = 0;

  // Map date index to X coordinate
  const dateToX = (idx: number) =>
    pad.left + (idx / (sortedDates.length - 1)) * chartW;

  // Map value to Y coordinate (inverted: higher value = lower Y)
  const valToY = (v: number) =>
    linearScale(v, minY, maxStackedY, pad.top + chartH, pad.top);

  const baselineY = valToY(0);

  // --- Y-axis grid ---
  const yGridValues = computeYGrid(minY, maxStackedY, 4);
  const gridElements = yGridValues.map((val) => {
    const y = valToY(val);
    return (
      <g key={`ygrid-${val}`}>
        <line
          x1={pad.left}
          y1={y}
          x2={width - pad.right}
          y2={y}
          stroke={CHART_TOKENS.gridLine}
          strokeWidth="1"
        />
        <text
          x={pad.left - 6}
          y={y + 4}
          fill={CHART_TOKENS.axisText}
          fontSize="10"
          textAnchor="end"
        >
          {formatAxisValue(val)}
        </text>
      </g>
    );
  });

  // --- X-axis date labels ---
  const maxXTicks = Math.min(8, sortedDates.length);
  const xTickIndices = pickTickIndices(sortedDates.length, maxXTicks);
  const xLabels = xTickIndices.map((idx) => {
    const x = dateToX(idx);
    return (
      <text
        key={`xlabel-${idx}`}
        x={x}
        y={height - pad.bottom + 18}
        fill={CHART_TOKENS.axisText}
        fontSize="9"
        textAnchor="middle"
      >
        {formatDateLabel(sortedDates[idx])}
      </text>
    );
  });

  // --- Config change markers ---
  const markers = (configChanges ?? []).map((cc) => {
    const idx = sortedDates.indexOf(cc.date);
    if (idx < 0) return null;
    const x = dateToX(idx);
    return (
      <g key={`cc-${cc.date}`}>
        <line
          x1={x}
          y1={pad.top}
          x2={x}
          y2={pad.top + chartH}
          stroke="#d29922"
          strokeWidth="1"
          strokeDasharray="4,4"
        />
        <text
          x={x}
          y={pad.top - 3}
          fill="#d29922"
          fontSize="9"
          textAnchor="middle"
        >
          {"\u2699"}
        </text>
      </g>
    );
  });

  // --- Stacked areas + lines (render in order, bottom stage first) ---
  const areaElements: React.JSX.Element[] = [];
  const lineElements: React.JSX.Element[] = [];

  // We need the previous stage's top as the current stage's bottom
  let prevCoords: Array<[number, number]> = sortedDates.map((_, i) => [
    dateToX(i),
    baselineY,
  ]);

  for (let si = 0; si < stages.length; si++) {
    const stage = stages[si];
    const topCoords: Array<[number, number]> = sortedDates.map((_, i) => [
      dateToX(i),
      valToY(stackedValues[stage][i]),
    ]);

    // Area polygon: top line forward, then previous stage's top in reverse
    const areaTop = topCoords.map(([x, y]) => `${round(x, 1)},${round(y, 1)}`);
    const areaBottom = [...prevCoords]
      .reverse()
      .map(([x, y]) => `${round(x, 1)},${round(y, 1)}`);
    const areaPoints = [...areaTop, ...areaBottom].join(" ");

    const color = STAGE_COLORS[si % STAGE_COLORS.length];

    areaElements.push(
      <polygon
        key={`area-${stage}`}
        points={areaPoints}
        fill={color}
        fillOpacity={CHART_TOKENS.areaOpacity}
      />,
    );

    lineElements.push(
      <polyline
        key={`line-${stage}`}
        points={buildPointsString(topCoords)}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />,
    );

    prevCoords = topCoords;
  }

  // --- Legend ---
  const legendY = height - 12;
  const legendSpacing = 100;
  const legend = stages.map((stage, si) => {
    const x = pad.left + si * legendSpacing;
    const color = STAGE_COLORS[si % STAGE_COLORS.length];
    return (
      <g key={`legend-${stage}`}>
        <rect
          x={x}
          y={legendY - 8}
          width="10"
          height="10"
          fill={color}
          rx="2"
        />
        <text
          x={x + 14}
          y={legendY + 1}
          fill={CHART_TOKENS.legendText}
          fontSize="10"
        >
          {stage}
        </text>
      </g>
    );
  });

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      xmlns="http://www.w3.org/2000/svg"
      style={{ background: CHART_TOKENS.bg, borderRadius: "6px" }}
      aria-label="Per-stage utilization stacked area chart"
      role="img"
    >
      {gridElements}
      {areaElements}
      {lineElements}
      {markers}
      {xLabels}
      {legend}
    </svg>
  );
}
