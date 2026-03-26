/**
 * Section 2: Metrics Panel
 * Four KPI cards displaying dynamic numeric values with delta indicators.
 *
 * Props:
 *   - metrics: Array<{ label: string, value: string, delta: string, trend: "up"|"down"|"flat" }>
 */
// STRUCTURAL CONTRACT v2
// ┌──────────────────────────────────────────────────────────┐
// │ ┌────────┐ ┌────────┐ ┌────────┐ ┌────────┐            │
// │ │ Label  │ │ Label  │ │ Label  │ │ Label  │            │
// │ │ Value  │ │ Value  │ │ Value  │ │ Value  │            │
// │ │ Delta  │ │ Delta  │ │ Delta  │ │ Delta  │            │
// │ └────────┘ └────────┘ └────────┘ └────────┘            │
// └──────────────────────────────────────────────────────────┘
export default function MetricsPanel({ metrics }) {
  const trendColor = { up: "#10B981", down: "#EF4444", flat: "#64748B" };
  const trendIcon = { up: "↑", down: "↓", flat: "—" };

  return (
    <section
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(4, 1fr)",
        gap: "16px",
        padding: "24px 32px",
        width: "1440px",
        height: "280px",
        boxSizing: "border-box",
      }}
    >
      {metrics.map((m, i) => (
        <div
          key={i}
          style={{
            background: "#FFFFFF",
            borderRadius: "8px",
            border: "1px solid #E2E8F0",
            padding: "24px",
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            transition: "box-shadow 150ms ease",
          }}
        >
          <span
            style={{
              fontFamily: "Inter",
              fontSize: "12px",
              fontWeight: 400,
              color: "#64748B",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
              marginBottom: "8px",
            }}
          >
            {m.label}
          </span>
          <span
            style={{
              fontFamily: "Inter",
              fontSize: "32px",
              fontWeight: 700,
              color: "#0F172A",
              lineHeight: "1.2",
            }}
          >
            {m.value}
          </span>
          <span
            style={{
              fontFamily: "Inter",
              fontSize: "13px",
              fontWeight: 500,
              color: trendColor[m.trend],
              marginTop: "8px",
            }}
          >
            {trendIcon[m.trend]} {m.delta}
          </span>
        </div>
      ))}
    </section>
  );
}
