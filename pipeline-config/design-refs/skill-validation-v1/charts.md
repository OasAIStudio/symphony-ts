# Charts: skill-validation-v1

> SVG chart specifications extracted from the design.

## Token Usage Trend

- **Type**: Multi-line chart
- **X-Axis**: Day of week (Mon–Sun)
- **Y-Axis**: Token count (0–2,000,000)
- **Series**:
  - `agent-alpha` — solid blue line (#1E40AF)
  - `agent-beta` — solid indigo line (#6366F1)
  - `agent-gamma` — solid emerald line (#10B981)
- **Data Points**: 7 per series (one per day)
- **Grid**: Horizontal dashed lines at 500K intervals
- **Legend**: Bottom-aligned, horizontal layout with colored circles
- **Source Section**: chart-section

## Cost Sparklines (inline)

- **Type**: Sparkline
- **Location**: Embedded in data-table rows, "Cost" column
- **X-Axis**: Implicit (last 7 data points)
- **Y-Axis**: Implicit (min–max of series)
- **Series**: 1 per row (3 total)
- **Stroke**: 1.5px, color matches row status indicator
- **Source Section**: data-table
