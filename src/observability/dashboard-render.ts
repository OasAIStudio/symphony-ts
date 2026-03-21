import type { RuntimeSnapshot } from "../logging/runtime-snapshot.js";
import {
  escapeHtml,
  formatInteger,
  formatRuntimeAndTurns,
  formatRuntimeSeconds,
  prettyValue,
  stateBadgeClass,
} from "./dashboard-format.js";

export interface DashboardRenderOptions {
  liveUpdatesEnabled: boolean;
}

const DASHBOARD_STYLES = String.raw`
      :root {
        color-scheme: light;
        --page: #f7f7f8;
        --page-soft: #fbfbfc;
        --page-deep: #ececf1;
        --card: rgba(255, 255, 255, 0.94);
        --card-muted: #f3f4f6;
        --ink: #202123;
        --muted: #6e6e80;
        --line: #ececf1;
        --line-strong: #d9d9e3;
        --accent: #10a37f;
        --accent-ink: #0f513f;
        --accent-soft: #e8faf4;
        --danger: #b42318;
        --danger-soft: #fef3f2;
        --warning: #8a5a00;
        --warning-soft: #fff7e8;
        --warning-line: #f1d8a6;
        --shadow-sm: 0 1px 2px rgba(16, 24, 40, 0.05);
        --shadow-lg: 0 20px 50px rgba(15, 23, 42, 0.08);
      }
      * {
        box-sizing: border-box;
      }
      html {
        background: var(--page);
      }
      body {
        margin: 0;
        min-height: 100vh;
        background:
          radial-gradient(circle at top, rgba(16, 163, 127, 0.12) 0%, rgba(16, 163, 127, 0) 30%),
          linear-gradient(180deg, var(--page-soft) 0%, var(--page) 24%, #f3f4f6 100%);
        color: var(--ink);
        font-family: "Sohne", "SF Pro Text", "Helvetica Neue", "Segoe UI", sans-serif;
        line-height: 1.5;
      }
      a {
        color: var(--ink);
        text-decoration: none;
        transition: color 140ms ease;
      }
      a:hover {
        color: var(--accent);
      }
      button {
        appearance: none;
        border: 1px solid var(--accent);
        background: var(--accent);
        color: white;
        border-radius: 999px;
        padding: 0.72rem 1.08rem;
        cursor: pointer;
        font: inherit;
        font-weight: 600;
        letter-spacing: -0.01em;
        box-shadow: 0 8px 20px rgba(16, 163, 127, 0.18);
        transition:
          transform 140ms ease,
          box-shadow 140ms ease,
          background 140ms ease,
          border-color 140ms ease;
      }
      button:hover {
        transform: translateY(-1px);
        box-shadow: 0 12px 24px rgba(16, 163, 127, 0.22);
      }
      .subtle-button {
        border: 1px solid var(--line-strong);
        background: rgba(255, 255, 255, 0.72);
        color: var(--muted);
        padding: 0.34rem 0.72rem;
        font-size: 0.82rem;
        letter-spacing: 0.01em;
        box-shadow: none;
      }
      .subtle-button:hover {
        transform: none;
        box-shadow: none;
        background: white;
        border-color: var(--muted);
        color: var(--ink);
      }
      code,
      pre,
      .mono {
        font-family: "Sohne Mono", "SFMono-Regular", "SF Mono", Consolas, "Liberation Mono", monospace;
      }
      .mono,
      .numeric {
        font-variant-numeric: tabular-nums slashed-zero;
        font-feature-settings: "tnum" 1, "zero" 1;
      }
      .app-shell {
        max-width: 1280px;
        margin: 0 auto;
        padding: 2rem 1rem 3.5rem;
      }
      .dashboard-shell {
        display: grid;
        gap: 1rem;
      }
      .hero-card,
      .section-card,
      .metric-card {
        background: var(--card);
        border: 1px solid rgba(217, 217, 227, 0.82);
        box-shadow: var(--shadow-sm);
        backdrop-filter: blur(18px);
      }
      .hero-card {
        border-radius: 28px;
        padding: clamp(1.25rem, 3vw, 2rem);
        box-shadow: var(--shadow-lg);
      }
      .hero-grid {
        display: grid;
        grid-template-columns: minmax(0, 1fr) auto;
        gap: 1.25rem;
        align-items: start;
      }
      .eyebrow {
        margin: 0;
        color: var(--muted);
        text-transform: uppercase;
        letter-spacing: 0.08em;
        font-size: 0.76rem;
        font-weight: 600;
      }
      .hero-title {
        margin: 0.35rem 0 0;
        font-size: clamp(2rem, 4vw, 3.3rem);
        line-height: 0.98;
        letter-spacing: -0.04em;
      }
      .hero-copy {
        margin: 0.75rem 0 0;
        max-width: 46rem;
        color: var(--muted);
        font-size: 1rem;
      }
      .status-stack {
        display: grid;
        justify-items: end;
        align-content: start;
        min-width: min(100%, 9rem);
      }
      .status-badge {
        display: inline-flex;
        align-items: center;
        gap: 0.45rem;
        min-height: 2rem;
        padding: 0.35rem 0.78rem;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: var(--card-muted);
        color: var(--muted);
        font-size: 0.82rem;
        font-weight: 700;
        letter-spacing: 0.01em;
      }
      .status-badge-dot {
        width: 0.52rem;
        height: 0.52rem;
        border-radius: 999px;
        background: currentColor;
        opacity: 0.9;
      }
      .status-badge-live {
        background: var(--accent-soft);
        border-color: rgba(16, 163, 127, 0.18);
        color: var(--accent-ink);
      }
      .metric-grid {
        display: grid;
        gap: 0.85rem;
        grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      }
      .metric-card {
        border-radius: 22px;
        padding: 1rem 1.05rem 1.1rem;
      }
      .metric-label {
        margin: 0;
        color: var(--muted);
        font-size: 0.82rem;
        font-weight: 600;
        letter-spacing: 0.01em;
      }
      .metric-value {
        margin: 0.35rem 0 0;
        font-size: clamp(1.6rem, 2vw, 2.1rem);
        line-height: 1.05;
        letter-spacing: -0.03em;
      }
      .metric-detail {
        margin: 0.45rem 0 0;
        color: var(--muted);
        font-size: 0.88rem;
      }
      .section-card {
        border-radius: 24px;
        padding: 1.15rem;
      }
      .section-header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        gap: 1rem;
        flex-wrap: wrap;
      }
      .section-title {
        margin: 0;
        font-size: 1.08rem;
        line-height: 1.2;
        letter-spacing: -0.02em;
      }
      .section-copy {
        margin: 0.35rem 0 0;
        color: var(--muted);
        font-size: 0.94rem;
      }
      .table-wrap {
        overflow-x: auto;
        margin-top: 1rem;
      }
      .data-table {
        width: 100%;
        min-width: 720px;
        border-collapse: collapse;
      }
      .data-table-running {
        table-layout: fixed;
        min-width: 980px;
      }
      .data-table th {
        padding: 0 0.5rem 0.75rem 0;
        text-align: left;
        color: var(--muted);
        font-size: 0.78rem;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .data-table td {
        padding: 0.9rem 0.5rem 0.9rem 0;
        border-top: 1px solid var(--line);
        vertical-align: top;
        font-size: 0.94rem;
      }
      .issue-stack,
      .session-stack,
      .detail-stack,
      .token-stack {
        display: grid;
        gap: 0.24rem;
        min-width: 0;
      }
      .event-text {
        font-weight: 500;
        line-height: 1.45;
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .event-meta {
        max-width: 100%;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .state-badge {
        display: inline-flex;
        align-items: center;
        min-height: 1.85rem;
        padding: 0.3rem 0.68rem;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: var(--card-muted);
        color: var(--ink);
        font-size: 0.8rem;
        font-weight: 600;
        line-height: 1;
      }
      .state-badge-active {
        background: var(--accent-soft);
        border-color: rgba(16, 163, 127, 0.18);
        color: var(--accent-ink);
      }
      .state-badge-warning {
        background: var(--warning-soft);
        border-color: var(--warning-line);
        color: var(--warning);
      }
      .state-badge-danger {
        background: var(--danger-soft);
        border-color: #f6d3cf;
        color: var(--danger);
      }
      .health-badge {
        display: inline-flex;
        align-items: center;
        gap: 0.3rem;
        min-height: 1.85rem;
        padding: 0.3rem 0.68rem;
        border-radius: 999px;
        border: 1px solid var(--line);
        background: var(--card-muted);
        color: var(--ink);
        font-size: 0.8rem;
        font-weight: 600;
        line-height: 1;
      }
      .health-badge-dot {
        display: inline-block;
        width: 0.5rem;
        height: 0.5rem;
        border-radius: 50%;
        background: var(--ink-muted);
      }
      .health-badge-green { background: var(--accent-soft); border-color: rgba(16, 163, 127, 0.18); color: var(--accent-ink); }
      .health-badge-green .health-badge-dot { background: var(--accent); }
      .health-badge-yellow { background: var(--warning-soft); border-color: var(--warning-line); color: var(--warning); }
      .health-badge-yellow .health-badge-dot { background: var(--warning); }
      .health-badge-red { background: var(--danger-soft); border-color: #f6d3cf; color: var(--danger); }
      .health-badge-red .health-badge-dot { background: var(--danger); }
      .issue-id {
        font-weight: 600;
        letter-spacing: -0.01em;
      }
      .issue-link {
        color: var(--muted);
        font-size: 0.86rem;
      }
      .muted {
        color: var(--muted);
      }
      .code-panel {
        margin-top: 1rem;
        padding: 1rem;
        border-radius: 18px;
        background: #f5f5f7;
        border: 1px solid var(--line);
        color: #353740;
        font-size: 0.9rem;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .empty-state {
        margin: 1rem 0 0;
        color: var(--muted);
      }
      .expand-toggle {
        border: 1px solid var(--line-strong);
        background: rgba(255, 255, 255, 0.72);
        color: var(--muted);
        border-radius: 4px;
        padding: 0.18rem 0.48rem;
        font-size: 0.78rem;
        font-weight: 600;
        letter-spacing: 0.01em;
        box-shadow: none;
        cursor: pointer;
        transition: background 120ms ease, color 120ms ease;
        margin-top: 0.3rem;
      }
      .expand-toggle:hover {
        transform: none;
        box-shadow: none;
        background: white;
        border-color: var(--muted);
        color: var(--ink);
      }
      .detail-row > td {
        padding: 0;
        border-top: none;
      }
      .detail-panel {
        padding: 1rem 1.25rem;
        background: var(--page-soft);
        border-top: 1px solid var(--line);
        border-bottom: 2px solid var(--line-strong);
      }
      .detail-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 1rem;
      }
      .detail-section {
        min-width: 0;
      }
      .detail-section-title {
        margin: 0 0 0.45rem;
        font-size: 0.78rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        color: var(--muted);
      }
      .detail-kv {
        display: grid;
        grid-template-columns: auto 1fr;
        gap: 0.12rem 0.75rem;
        font-size: 0.88rem;
      }
      .detail-kv-label {
        color: var(--muted);
        white-space: nowrap;
      }
      .detail-kv-value {
        font-variant-numeric: tabular-nums slashed-zero;
        font-feature-settings: "tnum" 1, "zero" 1;
      }
      .turn-timeline {
        list-style: none;
        margin: 0;
        padding: 0;
        font-size: 0.84rem;
        max-height: 9rem;
        overflow-y: auto;
      }
      .turn-timeline li {
        display: grid;
        grid-template-columns: 2rem 1fr;
        gap: 0.3rem;
        padding: 0.22rem 0;
        border-top: 1px solid var(--line);
        align-items: baseline;
      }
      .turn-timeline li:first-child {
        border-top: none;
      }
      .turn-num {
        color: var(--muted);
        font-size: 0.78rem;
        font-weight: 700;
        text-align: right;
      }
      .turn-msg {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        color: var(--ink);
      }
      .exec-history-table {
        width: 100%;
        border-collapse: collapse;
        font-size: 0.84rem;
      }
      .exec-history-table th {
        text-align: left;
        padding: 0 0.4rem 0.35rem 0;
        font-size: 0.74rem;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--muted);
      }
      .exec-history-table td {
        padding: 0.2rem 0.4rem 0.2rem 0;
        border-top: 1px solid var(--line);
        vertical-align: top;
      }
      @media (max-width: 860px) {
        .app-shell {
          padding: 1rem 0.85rem 2rem;
        }
        .hero-grid {
          grid-template-columns: 1fr;
        }
        .status-stack {
          justify-items: start;
        }
        .metric-grid {
          grid-template-columns: repeat(2, minmax(0, 1fr));
        }
      }
      @media (max-width: 560px) {
        .metric-grid {
          grid-template-columns: 1fr;
        }
        .section-card,
        .hero-card {
          border-radius: 20px;
          padding: 1rem;
        }
      }
`;

export function renderDashboardHtml(
  snapshot: RuntimeSnapshot,
  options: DashboardRenderOptions,
): string {
  const initialRuntimeLabel = formatRuntimeSeconds(
    snapshot.codex_totals.seconds_running,
  );
  const totalTokensLabel = formatInteger(snapshot.codex_totals.total_tokens);
  const inputTokensLabel = formatInteger(snapshot.codex_totals.input_tokens);
  const outputTokensLabel = formatInteger(snapshot.codex_totals.output_tokens);
  const initialRateLimits = prettyValue(snapshot.rate_limits);

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Symphony Observability</title>
    <style>
${DASHBOARD_STYLES}
    </style>
  </head>
  <body>
    <main class="app-shell">
      <section class="dashboard-shell">
        <header class="hero-card">
          <div class="hero-grid">
            <div>
              <p class="eyebrow">Symphony Observability</p>
              <h1 class="hero-title">Operations Dashboard</h1>
              <p class="hero-copy">
                Current state, retry pressure, token usage, and orchestration health for the active Symphony runtime.
              </p>
            </div>

            <div class="status-stack">
              <span id="live-status" class="status-badge${
                options.liveUpdatesEnabled ? " status-badge-live" : ""
              }">
                <span class="status-badge-dot"></span>
                <span>${options.liveUpdatesEnabled ? "Live" : "Offline"}</span>
              </span>
            </div>
          </div>
        </header>

        <section class="metric-grid">
          <article class="metric-card">
            <p class="metric-label">Running</p>
            <p id="metric-running" class="metric-value numeric">${snapshot.counts.running}</p>
            <p class="metric-detail">Active issue sessions in the current runtime.</p>
          </article>

          <article class="metric-card">
            <p class="metric-label">Retrying</p>
            <p id="metric-retrying" class="metric-value numeric">${snapshot.counts.retrying}</p>
            <p class="metric-detail">Issues waiting for the next retry window.</p>
          </article>

          <article class="metric-card">
            <p class="metric-label">Total tokens</p>
            <p id="metric-total" class="metric-value numeric">${totalTokensLabel}</p>
            <p id="metric-total-detail" class="metric-detail numeric">In ${inputTokensLabel} / Out ${outputTokensLabel}</p>
          </article>

          <article class="metric-card">
            <p class="metric-label">Runtime</p>
            <p id="metric-runtime" class="metric-value numeric">${initialRuntimeLabel}</p>
            <p id="generated-at" class="metric-detail">Generated at ${escapeHtml(snapshot.generated_at)}</p>
          </article>
        </section>

        <section class="section-card">
          <div class="section-header">
            <div>
              <h2 class="section-title">Rate limits</h2>
              <p class="section-copy">Latest upstream rate-limit snapshot, when available.</p>
            </div>
          </div>

          <pre id="rate-limits" class="code-panel">${escapeHtml(initialRateLimits)}</pre>
        </section>

        <section class="section-card">
          <div class="section-header">
            <div>
              <h2 class="section-title">Running sessions</h2>
              <p class="section-copy">Active issues, last known agent activity, and token usage.</p>
            </div>
          </div>

          <div class="table-wrap">
            <table class="data-table data-table-running">
              <colgroup>
                <col style="width: 12rem;" />
                <col style="width: 8rem;" />
                <col style="width: 7.5rem;" />
                <col style="width: 8.5rem;" />
                <col />
                <col style="width: 10rem;" />
              </colgroup>
              <thead>
                <tr>
                  <th>Issue</th>
                  <th>State</th>
                  <th>Session</th>
                  <th>Runtime / turns</th>
                  <th>Codex update</th>
                  <th>Tokens</th>
                </tr>
              </thead>
              <tbody id="running-rows">${renderRunningRows(snapshot)}</tbody>
            </table>
          </div>
        </section>

        <section class="section-card">
          <div class="section-header">
            <div>
              <h2 class="section-title">Retry queue</h2>
              <p class="section-copy">Issues waiting for the next retry window.</p>
            </div>
          </div>

          <div class="table-wrap">
            <table class="data-table" style="min-width: 680px;">
              <thead>
                <tr>
                  <th>Issue</th>
                  <th>Attempt</th>
                  <th>Due at</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody id="retry-rows">${renderRetryRows(snapshot)}</tbody>
            </table>
          </div>
        </section>
      </section>
    </main>
    <script>
${renderDashboardClientScript(snapshot, options)}
    </script>
  </body>
</html>`;
}

function renderDashboardClientScript(
  snapshot: RuntimeSnapshot,
  options: DashboardRenderOptions,
): string {
  return `      window.__SYMPHONY_SNAPSHOT__ = ${JSON.stringify(snapshot)};
      window.__SYMPHONY_LIVE_UPDATES__ = ${JSON.stringify(
        options.liveUpdatesEnabled,
      )};
      (function () {
        const snapshot = window.__SYMPHONY_SNAPSHOT__;
        const liveUpdatesEnabled = window.__SYMPHONY_LIVE_UPDATES__ === true;

        function escapeHtml(value) {
          return String(value ?? '')
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")
            .replaceAll('"', "&quot;")
            .replaceAll("'", "&#39;");
        }

        function formatInteger(value) {
          const number = Number(value);
          if (!Number.isFinite(number)) {
            return 'n/a';
          }
          return Math.trunc(number).toLocaleString('en-US');
        }

        function formatRuntimeSeconds(value) {
          const number = Number(value);
          if (!Number.isFinite(number) || number < 0) {
            return '0m 0s';
          }
          const wholeSeconds = Math.max(0, Math.trunc(number));
          const mins = Math.floor(wholeSeconds / 60);
          const secs = wholeSeconds % 60;
          return mins + 'm ' + secs + 's';
        }

        function runtimeSecondsFromStartedAt(startedAt, generatedAt) {
          const start = Date.parse(startedAt);
          const generated = Date.parse(generatedAt);
          if (!Number.isFinite(start) || !Number.isFinite(generated) || generated < start) {
            return 0;
          }
          return (generated - start) / 1000;
        }

        function formatRuntimeAndTurns(row, generatedAt) {
          const runtime = formatRuntimeSeconds(runtimeSecondsFromStartedAt(row.started_at, generatedAt));
          if (Number.isInteger(row.turn_count) && row.turn_count > 0) {
            return runtime + ' / ' + row.turn_count;
          }
          return runtime;
        }

        function stateBadgeClass(state) {
          const normalized = String(state || '').toLowerCase();
          if (normalized.includes('progress') || normalized.includes('running') || normalized.includes('active')) {
            return 'state-badge state-badge-active';
          }
          if (normalized.includes('blocked') || normalized.includes('error') || normalized.includes('failed')) {
            return 'state-badge state-badge-danger';
          }
          if (normalized.includes('todo') || normalized.includes('queued') || normalized.includes('pending') || normalized.includes('retry')) {
            return 'state-badge state-badge-warning';
          }
          return 'state-badge';
        }

        function prettyValue(value) {
          if (value == null) {
            return 'n/a';
          }
          try {
            return JSON.stringify(value, null, 2);
          } catch (_error) {
            return String(value);
          }
        }

        function renderDetailPanel(row, rowId) {
          const tokenBreakdown =
            '<div class="detail-section">' +
            '<p class="detail-section-title">Token breakdown</p>' +
            '<div class="detail-kv">' +
            '<span class="detail-kv-label">Input</span><span class="detail-kv-value numeric">' + formatInteger(row.tokens && row.tokens.input_tokens) + '</span>' +
            '<span class="detail-kv-label">Output</span><span class="detail-kv-value numeric">' + formatInteger(row.tokens && row.tokens.output_tokens) + '</span>' +
            '<span class="detail-kv-label">Total</span><span class="detail-kv-value numeric">' + formatInteger(row.tokens && row.tokens.total_tokens) + '</span>' +
            '<span class="detail-kv-label">Cache read</span><span class="detail-kv-value numeric">' + formatInteger(row.tokens && row.tokens.cache_read_tokens) + '</span>' +
            '<span class="detail-kv-label">Cache write</span><span class="detail-kv-value numeric">' + formatInteger(row.tokens && row.tokens.cache_write_tokens) + '</span>' +
            '<span class="detail-kv-label">Reasoning</span><span class="detail-kv-value numeric">' + formatInteger(row.tokens && row.tokens.reasoning_tokens) + '</span>' +
            '<span class="detail-kv-label">Pipeline</span><span class="detail-kv-value numeric">' + formatInteger(row.total_pipeline_tokens) + '</span>' +
            '</div></div>';

          const turnHistoryItems = (!row.turn_history || row.turn_history.length === 0)
            ? '<li><span class="turn-num">\u2014</span><span class="turn-msg muted">No turns recorded.</span></li>'
            : row.turn_history.map(function (t) {
                return '<li><span class="turn-num">' + escapeHtml(t.turnNumber) + '</span><span class="turn-msg" title="' + escapeHtml(t.message || '') + '">' + escapeHtml(t.message || '(no message)') + '</span></li>';
              }).join('');
          const turnHistory =
            '<div class="detail-section">' +
            '<p class="detail-section-title">Turn history</p>' +
            '<ul class="turn-timeline">' + turnHistoryItems + '</ul>' +
            '</div>';

          const execRows = (!row.execution_history || row.execution_history.length === 0)
            ? '<tr><td colspan="4" class="muted">No completed stages.</td></tr>'
            : row.execution_history.map(function (s) {
                return '<tr><td>' + escapeHtml(s.stageName) + '</td><td class="numeric">' + formatInteger(s.turns) + '</td><td class="numeric">' + formatInteger(s.totalTokens) + '</td><td>' + escapeHtml(s.outcome) + '</td></tr>';
              }).join('');
          const executionHistory =
            '<div class="detail-section">' +
            '<p class="detail-section-title">Execution history</p>' +
            '<table class="exec-history-table"><thead><tr><th>Stage</th><th>Turns</th><th>Tokens</th><th>Outcome</th></tr></thead>' +
            '<tbody>' + execRows + '</tbody></table>' +
            '</div>';

          return '<div class="detail-panel"><div class="detail-grid">' + tokenBreakdown + turnHistory + executionHistory + '</div></div>';
        }

        function renderRunningRows(next) {
          if (!next.running || next.running.length === 0) {
            return '<tr><td colspan="6"><p class="empty-state">No active sessions.</p></td></tr>';
          }

          return next.running.map(function (row) {
            const detailId = 'detail-' + String(row.issue_identifier).replace(/[^a-zA-Z0-9]/g, '-');
            const sessionCell = row.session_id
              ? '<button type="button" class="subtle-button" data-label="Copy ID" data-copy="' + escapeHtml(row.session_id) + '" onclick="navigator.clipboard.writeText(this.dataset.copy); this.textContent = \\'Copied\\'; clearTimeout(this._copyTimer); this._copyTimer = setTimeout(() => { this.textContent = this.dataset.label }, 1200);">Copy ID</button>'
              : '<span class="muted">n/a</span>';

            const eventMeta = row.last_event
              ? escapeHtml(row.last_event) + (row.last_event_at ? ' · <span class="mono numeric">' + escapeHtml(row.last_event_at) + '</span>' : '')
              : 'n/a';

            const pipelineStageHtml = (row.pipeline_stage != null)
              ? '<span class="muted">' + escapeHtml(row.pipeline_stage) + '</span>'
              : '';
            const reworkHtml = (row.rework_count != null && row.rework_count > 0)
              ? '<span class="state-badge state-badge-warning">Rework \xD7' + escapeHtml(row.rework_count) + '</span>'
              : '';
            const healthLabel = row.health === 'red' ? '\uD83D\uDD34 Red' : row.health === 'yellow' ? '\uD83D\uDFE1 Yellow' : '\uD83D\uDFE2 Green';
            const healthClass = 'health-badge health-badge-' + (row.health || 'green');
            const healthTitle = row.health_reason ? ' title="' + escapeHtml(row.health_reason) + '"' : '';
            const healthHtml = '<span class="' + healthClass + '"' + healthTitle + '><span class="health-badge-dot"></span>' + escapeHtml(healthLabel) + '</span>';
            const activityText = row.activity_summary || row.last_event || 'n/a';
            const expandToggle = '<button type="button" class="expand-toggle" aria-expanded="false" data-detail="' + escapeHtml(detailId) + '" onclick="const d=document.getElementById(this.dataset.detail);const open=this.getAttribute(\\'aria-expanded\\')=== \\'true\\';d.style.display=open?\\'none\\':\\'table-row\\';this.setAttribute(\\'aria-expanded\\',String(!open));this.textContent=open?\\'\u25B6 Details\\':\\'\u25BC Details\\';">\u25B6 Details</button>';

            const detailRow = '<tr id="' + escapeHtml(detailId) + '" class="detail-row" style="display:none;"><td colspan="6">' + renderDetailPanel(row, detailId) + '</td></tr>';

            return '<tr class="session-row">' +
              '<td><div class="issue-stack"><span class="issue-id">' + escapeHtml(row.issue_identifier) + '</span><a class="issue-link" href="/api/v1/' + encodeURIComponent(row.issue_identifier) + '">JSON details</a>' + pipelineStageHtml + expandToggle + '</div></td>' +
              '<td><div class="detail-stack"><span class="' + stateBadgeClass(row.state) + '">' + escapeHtml(row.state) + '</span>' + reworkHtml + healthHtml + '</div></td>' +
              '<td><div class="session-stack">' + sessionCell + '</div></td>' +
              '<td class="numeric">' + formatRuntimeAndTurns(row, next.generated_at) + '</td>' +
              '<td><div class="detail-stack"><span class="event-text" title="' + escapeHtml(activityText) + '">' + escapeHtml(activityText) + '</span><span class="muted event-meta">' + eventMeta + '</span></div></td>' +
              '<td><div class="token-stack numeric"><span>Total: ' + formatInteger(row.tokens && row.tokens.total_tokens) + '</span><span class="muted">In ' + formatInteger(row.tokens && row.tokens.input_tokens) + ' / Out ' + formatInteger(row.tokens && row.tokens.output_tokens) + '</span><span class="muted">' + formatInteger(row.tokens_per_turn) + ' / turn</span><span class="muted">Pipeline: ' + formatInteger(row.total_pipeline_tokens) + '</span></div></td>' +
              '</tr>' + detailRow;
          }).join('');
        }

        function renderRetryRows(next) {
          if (!next.retrying || next.retrying.length === 0) {
            return '<tr><td colspan="4"><p class="empty-state">No issues are currently backing off.</p></td></tr>';
          }

          return next.retrying.map(function (row) {
            return '<tr>' +
              '<td><div class="issue-stack"><span class="issue-id">' + escapeHtml(row.issue_identifier || row.issue_id) + '</span><a class="issue-link" href="/api/v1/' + encodeURIComponent(row.issue_identifier || row.issue_id) + '">JSON details</a></div></td>' +
              '<td>' + escapeHtml(row.attempt) + '</td>' +
              '<td class="mono">' + escapeHtml(row.due_at || 'n/a') + '</td>' +
              '<td>' + escapeHtml(row.error || 'n/a') + '</td>' +
              '</tr>';
          }).join('');
        }

        function setStatus(text, live) {
          const element = document.getElementById('live-status');
          if (!element) return;
          element.className = live ? 'status-badge status-badge-live' : 'status-badge';
          const label = element.querySelector('span:last-child');
          if (label) {
            label.textContent = text;
          }
        }

        function render(next) {
          document.getElementById('generated-at').textContent = 'Generated at ' + next.generated_at;
          document.getElementById('metric-running').textContent = String(next.counts.running);
          document.getElementById('metric-retrying').textContent = String(next.counts.retrying);
          document.getElementById('metric-total').textContent = formatInteger(next.codex_totals.total_tokens);
          document.getElementById('metric-total-detail').textContent = 'In ' + formatInteger(next.codex_totals.input_tokens) + ' / Out ' + formatInteger(next.codex_totals.output_tokens);
          document.getElementById('metric-runtime').textContent = formatRuntimeSeconds(next.codex_totals.seconds_running);
          document.getElementById('running-rows').innerHTML = renderRunningRows(next);
          document.getElementById('retry-rows').innerHTML = renderRetryRows(next);
          document.getElementById('rate-limits').textContent = prettyValue(next.rate_limits);
        }

        render(snapshot);
        if (!liveUpdatesEnabled || typeof window.EventSource !== 'function') {
          return;
        }

        const source = new window.EventSource('/api/v1/events');
        source.addEventListener('open', function () {
          setStatus('Live', true);
        });
        source.addEventListener('snapshot', function (event) {
          try {
            const next = JSON.parse(event.data);
            render(next);
            setStatus('Live', true);
          } catch (_error) {
            setStatus('Degraded', false);
          }
        });
        source.addEventListener('error', function () {
          setStatus('Reconnecting', false);
        });
      })();`;
}

function renderRunningRows(snapshot: RuntimeSnapshot): string {
  if (snapshot.running.length === 0) {
    return '<tr><td colspan="6"><p class="empty-state">No active sessions.</p></td></tr>';
  }
  return snapshot.running
    .map((row) => {
      const detailId = `detail-${row.issue_identifier.replace(/[^a-zA-Z0-9]/g, "-")}`;
      const detailPanel = renderDetailPanel(row);
      return `
            <tr class="session-row">
              <td>
                <div class="issue-stack">
                  <span class="issue-id">${escapeHtml(row.issue_identifier)}</span>
                  <a class="issue-link" href="/api/v1/${encodeURIComponent(
                    row.issue_identifier,
                  )}">JSON details</a>
                  ${row.pipeline_stage !== null && row.pipeline_stage !== undefined ? `<span class="muted">${escapeHtml(row.pipeline_stage)}</span>` : ""}
                  <button type="button" class="expand-toggle" aria-expanded="false" data-detail="${escapeHtml(detailId)}" onclick="const d=document.getElementById(this.dataset.detail);const open=this.getAttribute('aria-expanded')==='true';d.style.display=open?'none':'table-row';this.setAttribute('aria-expanded',String(!open));this.textContent=open?'\u25B6 Details':'\u25BC Details';">&#x25B6; Details</button>
                </div>
              </td>
              <td>
                <div class="detail-stack">
                  <span class="${stateBadgeClass(row.state)}">${escapeHtml(row.state)}</span>
                  ${row.rework_count !== undefined && row.rework_count > 0 ? `<span class="state-badge state-badge-warning">Rework ×${escapeHtml(row.rework_count)}</span>` : ""}
                  ${renderHealthBadge(row.health, row.health_reason)}
                </div>
              </td>
              <td>
                <div class="session-stack">
                  ${
                    row.session_id === null
                      ? '<span class="muted">n/a</span>'
                      : `<button type="button" class="subtle-button" data-label="Copy ID" data-copy="${escapeHtml(
                          row.session_id,
                        )}" onclick="navigator.clipboard.writeText(this.dataset.copy); this.textContent = 'Copied'; clearTimeout(this._copyTimer); this._copyTimer = setTimeout(() => { this.textContent = this.dataset.label }, 1200);">Copy ID</button>`
                  }
                </div>
              </td>
              <td class="numeric">${formatRuntimeAndTurns(
                row.started_at,
                row.turn_count,
                snapshot.generated_at,
              )}</td>
              <td>
                <div class="detail-stack">
                  <span class="event-text" title="${escapeHtml(
                    row.activity_summary ?? row.last_event ?? "n/a",
                  )}">${escapeHtml(
                    row.activity_summary ?? row.last_event ?? "n/a",
                  )}</span>
                  <span class="muted event-meta">${escapeHtml(
                    row.last_event ?? "n/a",
                  )}${
                    row.last_event_at === null
                      ? ""
                      : ` · <span class="mono numeric">${escapeHtml(
                          row.last_event_at,
                        )}</span>`
                  }</span>
                </div>
              </td>
              <td>
                <div class="token-stack numeric">
                  <span>Total: ${formatInteger(row.tokens.total_tokens)}</span>
                  <span class="muted">In ${formatInteger(
                    row.tokens.input_tokens,
                  )} / Out ${formatInteger(row.tokens.output_tokens)}</span>
                  <span class="muted">${formatInteger(row.tokens_per_turn)} / turn</span>
                  <span class="muted">Pipeline: ${formatInteger(row.total_pipeline_tokens)}</span>
                </div>
              </td>
            </tr>
            <tr id="${escapeHtml(detailId)}" class="detail-row" style="display:none;">
              <td colspan="6">${detailPanel}</td>
            </tr>`;
    })
    .join("");
}

function renderDetailPanel(row: RuntimeSnapshot["running"][number]): string {
  const tokenBreakdown = `
    <div class="detail-section">
      <p class="detail-section-title">Token breakdown</p>
      <div class="detail-kv">
        <span class="detail-kv-label">Input</span><span class="detail-kv-value numeric">${formatInteger(row.tokens.input_tokens)}</span>
        <span class="detail-kv-label">Output</span><span class="detail-kv-value numeric">${formatInteger(row.tokens.output_tokens)}</span>
        <span class="detail-kv-label">Total</span><span class="detail-kv-value numeric">${formatInteger(row.tokens.total_tokens)}</span>
        <span class="detail-kv-label">Cache read</span><span class="detail-kv-value numeric">${formatInteger(row.tokens.cache_read_tokens)}</span>
        <span class="detail-kv-label">Cache write</span><span class="detail-kv-value numeric">${formatInteger(row.tokens.cache_write_tokens)}</span>
        <span class="detail-kv-label">Reasoning</span><span class="detail-kv-value numeric">${formatInteger(row.tokens.reasoning_tokens)}</span>
        <span class="detail-kv-label">Pipeline</span><span class="detail-kv-value numeric">${formatInteger(row.total_pipeline_tokens)}</span>
      </div>
    </div>`;

  const turnHistoryRows =
    row.turn_history.length === 0
      ? '<li><span class="turn-num">—</span><span class="turn-msg muted">No turns recorded.</span></li>'
      : row.turn_history
          .map(
            (t) =>
              `<li><span class="turn-num">${escapeHtml(t.turnNumber)}</span><span class="turn-msg" title="${escapeHtml(t.message ?? "")}">${escapeHtml(t.message ?? "(no message)")}</span></li>`,
          )
          .join("");

  const turnHistory = `
    <div class="detail-section">
      <p class="detail-section-title">Turn history</p>
      <ul class="turn-timeline">${turnHistoryRows}</ul>
    </div>`;

  const execHistoryRows =
    row.execution_history.length === 0
      ? `<tr><td colspan="4" class="muted">No completed stages.</td></tr>`
      : row.execution_history
          .map(
            (s) =>
              `<tr><td>${escapeHtml(s.stageName)}</td><td class="numeric">${formatInteger(s.turns)}</td><td class="numeric">${formatInteger(s.totalTokens)}</td><td>${escapeHtml(s.outcome)}</td></tr>`,
          )
          .join("");

  const executionHistory = `
    <div class="detail-section">
      <p class="detail-section-title">Execution history</p>
      <table class="exec-history-table">
        <thead><tr><th>Stage</th><th>Turns</th><th>Tokens</th><th>Outcome</th></tr></thead>
        <tbody>${execHistoryRows}</tbody>
      </table>
    </div>`;

  return `<div class="detail-panel"><div class="detail-grid">${tokenBreakdown}${turnHistory}${executionHistory}</div></div>`;
}

function renderRetryRows(snapshot: RuntimeSnapshot): string {
  return snapshot.retrying.length === 0
    ? '<tr><td colspan="4"><p class="empty-state">No issues are currently backing off.</p></td></tr>'
    : snapshot.retrying
        .map(
          (row) => `
            <tr>
              <td>
                <div class="issue-stack">
                  <span class="issue-id">${escapeHtml(row.issue_identifier ?? row.issue_id)}</span>
                  <a class="issue-link" href="/api/v1/${encodeURIComponent(
                    row.issue_identifier ?? row.issue_id,
                  )}">JSON details</a>
                </div>
              </td>
              <td>${row.attempt}</td>
              <td class="mono">${escapeHtml(row.due_at)}</td>
              <td>${escapeHtml(row.error ?? "n/a")}</td>
            </tr>`,
        )
        .join("");
}

function renderHealthBadge(
  health: "green" | "yellow" | "red",
  healthReason: string | null,
): string {
  const label =
    health === "red"
      ? "🔴 Red"
      : health === "yellow"
        ? "🟡 Yellow"
        : "🟢 Green";
  const cssClass = `health-badge health-badge-${health}`;
  const title =
    healthReason !== null ? ` title="${escapeHtml(healthReason)}"` : "";
  return `<span class="${cssClass}"${title}><span class="health-badge-dot"></span>${escapeHtml(label)}</span>`;
}
