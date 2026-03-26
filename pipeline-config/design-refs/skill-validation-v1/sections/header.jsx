/**
 * Section 1: Header
 * Dashboard header with title, subtitle, and version badge.
 *
 * Props:
 *   - title: string (dashboard title text)
 *   - lastUpdated: string (ISO timestamp or human-readable date)
 *   - version: string (version badge text, e.g. "v2.4.1")
 */
// STRUCTURAL CONTRACT v2
// ┌─────────────────────────────────────────────────────┐
// │ [Title]                        [Version] [Updated]  │
// └─────────────────────────────────────────────────────┘
export default function Header({ title, lastUpdated, version }) {
  return (
    <header
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "24px 32px",
        background: "rgba(255,255,255,0.85)",
        backdropFilter: "blur(12px)",
        WebkitBackdropFilter: "blur(12px)",
        borderBottom: "1px solid #E2E8F0",
        width: "1440px",
        height: "120px",
        boxSizing: "border-box",
      }}
    >
      <h1
        style={{
          fontFamily: "Inter",
          fontSize: "28px",
          fontWeight: 700,
          color: "#0F172A",
          margin: 0,
          lineHeight: "1.2",
        }}
      >
        {title}
      </h1>
      <div style={{ display: "flex", alignItems: "center", gap: "16px" }}>
        <span
          style={{
            fontFamily: "Mono",
            fontSize: "13px",
            color: "#6366F1",
            background: "#EEF2FF",
            padding: "4px 10px",
            borderRadius: "4px",
          }}
        >
          {version}
        </span>
        <span
          style={{
            fontFamily: "Inter",
            fontSize: "12px",
            color: "#64748B",
          }}
        >
          Last updated: {lastUpdated}
        </span>
      </div>
    </header>
  );
}
