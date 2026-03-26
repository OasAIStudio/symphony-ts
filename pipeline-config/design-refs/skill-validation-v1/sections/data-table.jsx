/**
 * Section 3: Data Table
 * Agent status table with repeating rows, inline sparklines, and sortable columns.
 *
 * Props:
 *   - agents: Array<{ name: string, status: "Running"|"Idle"|"Error", tasks: number, tokens: string, cost: string, lastRun: string, sparkData: number[] }>
 *   - sortColumn: string (active sort column key)
 *   - sortDirection: "asc"|"desc"
 */
// STRUCTURAL CONTRACT v2
// ┌──────────────────────────────────────────────────────────────────┐
// │  Agent    │ Status │ Tasks │ Tokens │ Cost [sparkline] │ Last   │
// ├──────────────────────────────────────────────────────────────────┤
// │  row 1    │ ●      │       │        │ ~~~              │        │
// │  row 2    │ ●      │       │        │ ~~~              │        │
// │  row N    │ ●      │       │        │ ~~~              │        │
// └──────────────────────────────────────────────────────────────────┘
export default function DataTable({ agents, sortColumn, sortDirection }) {
  const statusColor = { Running: "#10B981", Idle: "#94A3B8", Error: "#EF4444" };
  const columns = ["Agent", "Status", "Tasks", "Tokens", "Cost", "Last Run"];

  function Sparkline({ data, color }) {
    if (!data || data.length < 2) return null;
    const h = 20;
    const w = 60;
    const max = Math.max(...data);
    const min = Math.min(...data);
    const range = max - min || 1;
    const points = data
      .map((v, i) => `${(i / (data.length - 1)) * w},${h - ((v - min) / range) * h}`)
      .join(" ");
    return (
      <svg width={w} height={h} style={{ verticalAlign: "middle", marginLeft: "8px" }}>
        <polyline fill="none" stroke={color} strokeWidth="1.5" points={points} />
      </svg>
    );
  }

  return (
    <section
      style={{
        padding: "0 32px",
        width: "1440px",
        height: "600px",
        boxSizing: "border-box",
        overflow: "auto",
      }}
    >
      <table
        style={{
          width: "100%",
          borderCollapse: "collapse",
          fontFamily: "Inter",
          fontSize: "14px",
        }}
      >
        <thead>
          <tr>
            {columns.map((col) => (
              <th
                key={col}
                style={{
                  textAlign: "left",
                  padding: "12px 16px",
                  borderBottom: "2px solid #E2E8F0",
                  fontWeight: 600,
                  color: "#0F172A",
                  cursor: "pointer",
                  userSelect: "none",
                }}
              >
                {col}
                {sortColumn === col && (
                  <span style={{ marginLeft: "4px" }}>
                    {sortDirection === "asc" ? "▲" : "▼"}
                  </span>
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {agents.map((agent, i) => (
            <tr
              key={i}
              style={{
                borderBottom: "1px solid #E2E8F0",
                transition: "background 150ms ease",
              }}
            >
              <td style={{ padding: "12px 16px", fontFamily: "Mono", fontSize: "13px" }}>
                {agent.name}
              </td>
              <td style={{ padding: "12px 16px" }}>
                <span
                  style={{
                    display: "inline-block",
                    width: "8px",
                    height: "8px",
                    borderRadius: "50%",
                    background: statusColor[agent.status],
                    marginRight: "8px",
                  }}
                />
                {agent.status}
              </td>
              <td style={{ padding: "12px 16px", fontFamily: "Mono" }}>{agent.tasks}</td>
              <td style={{ padding: "12px 16px", fontFamily: "Mono" }}>{agent.tokens}</td>
              <td style={{ padding: "12px 16px", fontFamily: "Mono" }}>
                {agent.cost}
                <Sparkline data={agent.sparkData} color={statusColor[agent.status]} />
              </td>
              <td style={{ padding: "12px 16px", color: "#64748B" }}>{agent.lastRun}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
