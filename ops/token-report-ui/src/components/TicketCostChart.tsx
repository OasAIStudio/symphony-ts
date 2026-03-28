/**
 * TicketCostChart — Line chart with median/mean reference lines.
 * Shows per-ticket token cost trend with horizontal reference lines
 * for median and mean values.
 * Converted from Paper design reference; pure SVG, no external charting libs.
 * Inline styles aligned with v5 per-ticket-cost-trend.jsx (SYMPH-198).
 */
import {
  CHART_TOKENS,
  DEFAULT_PADDING,
  buildPointsString,
  computeYGrid,
  formatAxisValue,
  linearScale,
  pickTickIndices,
  round,
} from "../lib/chart-utils.ts";
import type { PerTicketTrend } from "../types.ts";

export interface TicketCostChartProps {
  perTicket: PerTicketTrend;
  /** Time-series of per-ticket token values (one per data point). */
  series?: number[];
  width?: number;
  height?: number;
}

/**
 * Line chart for per-ticket cost trend with median and mean reference lines.
 * The main series is rendered as a stroked polyline with a subtle fill.
 * Horizontal dashed lines mark the overall median and mean.
 */
export default function TicketCostChart({
  perTicket,
  series,
  width = 600,
  height = 200,
}: TicketCostChartProps) {
  const pad = { ...DEFAULT_PADDING, bottom: 30 };
  const chartW = width - pad.left - pad.right;
  const chartH = height - pad.top - pad.bottom;

  const pt = perTicket ?? ({} as Partial<PerTicketTrend>);
  const median = pt.median ?? 0;
  const mean = pt.mean ?? 0;

  if (!series || series.length < 2) {
    return (
      <svg
        width={width}
        height={height}
        xmlns="http://www.w3.org/2000/svg"
        aria-label="Per-ticket cost chart — insufficient series data"
        role="img"
      >
        <text x="10" y="20" fill={CHART_TOKENS.axisText} fontSize="12">
          Insufficient series data for ticket cost chart
        </text>
        {/* Still show median/mean as static reference */}
        {median > 0 && (
          <text x="10" y="40" fill={CHART_TOKENS.medianStroke} fontSize="11">
            Median: {formatAxisValue(median)}
          </text>
        )}
        {mean > 0 && (
          <text x="10" y="56" fill={CHART_TOKENS.meanStroke} fontSize="11">
            Mean: {formatAxisValue(mean)}
          </text>
        )}
      </svg>
    );
  }

  // Determine Y range, including median/mean so reference lines are always visible
  const dataMin = Math.min(...series, median, mean);
  const dataMax = Math.max(...series, median, mean);
  const yPad = (dataMax - dataMin) * 0.1 || 1000;
  const minY = Math.max(0, dataMin - yPad);
  const maxY = dataMax + yPad;

  const valToY = (v: number) =>
    linearScale(v, minY, maxY, pad.top + chartH, pad.top);

  const idxToX = (i: number) => pad.left + (i / (series.length - 1)) * chartW;

  // --- Y-axis grid ---
  const yGridValues = computeYGrid(minY, maxY, 4);
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

  // --- X-axis tick labels (index-based since we don't have dates) ---
  const maxXTicks = Math.min(6, series.length);
  const xTickIndices = pickTickIndices(series.length, maxXTicks);
  const xLabels = xTickIndices.map((idx) => {
    const x = idxToX(idx);
    return (
      <text
        key={`xlabel-${idx}`}
        x={x}
        y={height - pad.bottom + 16}
        fill={CHART_TOKENS.axisText}
        fontSize="9"
        textAnchor="middle"
      >
        #{idx + 1}
      </text>
    );
  });

  // --- Main data line ---
  const lineCoords: Array<[number, number]> = series.map((v, i) => [
    idxToX(i),
    valToY(v),
  ]);

  // Subtle area fill under the line
  const baselineY = valToY(minY);
  const areaTop = lineCoords.map(([x, y]) => `${round(x, 1)},${round(y, 1)}`);
  const areaBottom = [...lineCoords]
    .reverse()
    .map(([x]) => `${round(x, 1)},${round(baselineY, 1)}`);
  const areaPoints = [...areaTop, ...areaBottom].join(" ");

  // --- Median reference line ---
  const medianY = valToY(median);
  const medianLine =
    median > 0 ? (
      <g key="ref-median">
        <line
          x1={pad.left}
          y1={medianY}
          x2={width - pad.right}
          y2={medianY}
          stroke={CHART_TOKENS.medianStroke}
          strokeWidth="1"
          strokeDasharray="6,3"
        />
        <text
          x={width - pad.right + 4}
          y={medianY + 4}
          fill={CHART_TOKENS.medianStroke}
          fontSize="9"
          textAnchor="start"
        >
          med {formatAxisValue(median)}
        </text>
      </g>
    ) : null;

  // --- Mean reference line ---
  const meanY = valToY(mean);
  const meanLine =
    mean > 0 ? (
      <g key="ref-mean">
        <line
          x1={pad.left}
          y1={meanY}
          x2={width - pad.right}
          y2={meanY}
          stroke={CHART_TOKENS.meanStroke}
          strokeWidth="1"
          strokeDasharray="3,3"
        />
        <text
          x={width - pad.right + 4}
          y={meanY + 4}
          fill={CHART_TOKENS.meanStroke}
          fontSize="9"
          textAnchor="start"
        >
          avg {formatAxisValue(mean)}
        </text>
      </g>
    ) : null;

  // --- Legend ---
  const legendY = height - 8;
  const legendItems = [
    { label: "Per-ticket", color: CHART_TOKENS.medianStroke, dash: false },
    { label: "Median", color: CHART_TOKENS.medianStroke, dash: true },
    { label: "Mean", color: CHART_TOKENS.meanStroke, dash: true },
  ];
  const legend = legendItems.map((item, i) => {
    const x = pad.left + i * 120;
    return (
      <g key={`legend-${item.label}`}>
        <line
          x1={x}
          y1={legendY - 4}
          x2={x + 16}
          y2={legendY - 4}
          stroke={item.color}
          strokeWidth="1.5"
          strokeDasharray={item.dash ? "4,2" : "none"}
        />
        <text
          x={x + 20}
          y={legendY}
          fill={CHART_TOKENS.legendText}
          fontSize="10"
        >
          {item.label}
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
      aria-label="Per-ticket cost trend chart"
      role="img"
    >
      {gridElements}
      <polygon
        points={areaPoints}
        fill={CHART_TOKENS.medianStroke}
        fillOpacity={0.08}
      />
      <polyline
        points={buildPointsString(lineCoords)}
        fill="none"
        stroke={CHART_TOKENS.medianStroke}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {medianLine}
      {meanLine}
      {xLabels}
      {legend}
    </svg>
  );
}
