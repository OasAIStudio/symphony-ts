/**
 * Section 4: Chart Section
 * Multi-line SVG chart showing token usage over time with legend and tooltip area.
 *
 * Props:
 *   - title: string (chart title)
 *   - subtitle: string (e.g. "Last 7 days")
 *   - series: Array<{ name: string, color: string, data: number[] }>
 *   - xLabels: string[] (x-axis labels, e.g. ["Mon","Tue",...])
 *   - yMax: number (max y-axis value)
 */
// STRUCTURAL CONTRACT v2
// ┌──────────────────────────────────────────────────────────┐
// │  [Title]                                   [Subtitle]    │
// │  ┌──────────────────────────────────────────────────┐    │
// │  │  Y │                                             │    │
// │  │    │      ╱╲                                     │    │
// │  │    │    ╱    ╲    ╱╲                              │    │
// │  │    │  ╱        ╲╱    ╲                            │    │
// │  │    └──────────────────────── X                   │    │
// │  └──────────────────────────────────────────────────┘    │
// │  [● Series A]  [● Series B]  [● Series C]               │
// └──────────────────────────────────────────────────────────┘
export default function ChartSection({ title, subtitle, series, xLabels, yMax }) {
  const chartW = 1200;
  const chartH = 360;
  const padL = 60;
  const padR = 20;
  const padT = 20;
  const padB = 40;
  const plotW = chartW - padL - padR;
  const plotH = chartH - padT - padB;

  function toPath(data) {
    return data
      .map((v, i) => {
        const x = padL + (i / (data.length - 1)) * plotW;
        const y = padT + plotH - (v / yMax) * plotH;
        return `${i === 0 ? "M" : "L"}${x},${y}`;
      })
      .join(" ");
  }

  const gridLines = [0, 0.25, 0.5, 0.75, 1].map((pct) => ({
    y: padT + plotH * (1 - pct),
    label: Math.round(yMax * pct).toLocaleString(),
  }));

  return (
    <section
      style={{
        padding: "24px 32px",
        width: "1440px",
        height: "520px",
        boxSizing: "border-box",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "baseline",
          marginBottom: "16px",
        }}
      >
        <h2
          style={{
            fontFamily: "Inter",
            fontSize: "18px",
            fontWeight: 600,
            color: "#0F172A",
            margin: 0,
          }}
        >
          {title}
        </h2>
        <span style={{ fontFamily: "Inter", fontSize: "12px", color: "#64748B" }}>
          {subtitle}
        </span>
      </div>

      <svg
        width={chartW}
        height={chartH}
        viewBox={`0 0 ${chartW} ${chartH}`}
        style={{ background: "#FFFFFF", borderRadius: "8px", border: "1px solid #E2E8F0" }}
      >
        {/* Grid lines */}
        {gridLines.map((g, i) => (
          <g key={i}>
            <line
              x1={padL}
              y1={g.y}
              x2={chartW - padR}
              y2={g.y}
              stroke="#E2E8F0"
              strokeDasharray="4 4"
            />
            <text
              x={padL - 8}
              y={g.y + 4}
              textAnchor="end"
              style={{ fontSize: "11px", fill: "#64748B", fontFamily: "Inter" }}
            >
              {g.label}
            </text>
          </g>
        ))}

        {/* X-axis labels */}
        {xLabels.map((label, i) => (
          <text
            key={i}
            x={padL + (i / (xLabels.length - 1)) * plotW}
            y={chartH - 8}
            textAnchor="middle"
            style={{ fontSize: "11px", fill: "#64748B", fontFamily: "Inter" }}
          >
            {label}
          </text>
        ))}

        {/* Data lines */}
        {series.map((s, i) => (
          <path
            key={i}
            d={toPath(s.data)}
            fill="none"
            stroke={s.color}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
      </svg>

      {/* Legend */}
      <div
        style={{
          display: "flex",
          gap: "24px",
          marginTop: "12px",
          justifyContent: "center",
        }}
      >
        {series.map((s, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "6px",
              cursor: "pointer",
            }}
          >
            <span
              style={{
                display: "inline-block",
                width: "10px",
                height: "10px",
                borderRadius: "50%",
                background: s.color,
              }}
            />
            <span style={{ fontFamily: "Inter", fontSize: "12px", color: "#64748B" }}>
              {s.name}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
