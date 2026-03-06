import {
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer,
} from "node:http";

import { ERROR_CODES } from "../errors/codes.js";
import type { RuntimeSnapshot } from "../logging/runtime-snapshot.js";

const DEFAULT_SNAPSHOT_TIMEOUT_MS = 1_000;

export interface IssueDetailRunningState {
  session_id: string | null;
  turn_count: number;
  state: string;
  started_at: string;
  last_event: string | null;
  last_message: string | null;
  last_event_at: string | null;
  tokens: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
  };
}

export interface IssueDetailRetryState {
  attempt: number;
  due_at: string;
  error: string | null;
}

export interface IssueDetailResponse {
  issue_identifier: string;
  issue_id: string;
  status: "claimed" | "released" | "retry_queued" | "running" | "unclaimed";
  workspace: {
    path: string;
  } | null;
  attempts: {
    restart_count: number;
    current_retry_attempt: number | null;
  };
  running: IssueDetailRunningState | null;
  retry: IssueDetailRetryState | null;
  logs: {
    codex_session_logs: Array<{
      label: string;
      path: string;
      url: string | null;
    }>;
  };
  recent_events: Array<{
    at: string;
    event: string;
    message: string | null;
  }>;
  last_error: string | null;
  tracked: Record<string, unknown>;
}

export interface RefreshResponse {
  queued: boolean;
  coalesced: boolean;
  requested_at: string;
  operations: string[];
}

export interface DashboardServerHost {
  getRuntimeSnapshot(): RuntimeSnapshot | Promise<RuntimeSnapshot>;
  getIssueDetails(
    issueIdentifier: string,
  ): IssueDetailResponse | null | Promise<IssueDetailResponse | null>;
  requestRefresh(): RefreshResponse | Promise<RefreshResponse>;
}

export interface DashboardServerOptions {
  host: DashboardServerHost;
  hostname?: string;
  snapshotTimeoutMs?: number;
}

export interface DashboardServerInstance {
  readonly server: Server;
  readonly hostname: string;
  readonly port: number;
  close(): Promise<void>;
}

export function createDashboardServer(options: DashboardServerOptions): Server {
  const hostname = options.hostname ?? "127.0.0.1";
  const handler = createDashboardRequestHandler({
    host: options.host,
    hostname,
    ...(options.snapshotTimeoutMs === undefined
      ? {}
      : { snapshotTimeoutMs: options.snapshotTimeoutMs }),
  });
  return createServer((request, response) => {
    void handler(request, response);
  });
}

export async function startDashboardServer(
  options: DashboardServerOptions & {
    port: number;
  },
): Promise<DashboardServerInstance> {
  const server = createDashboardServer(options);
  const hostname = options.hostname ?? "127.0.0.1";

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, hostname, () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Dashboard server did not bind to a TCP address.");
  }

  return {
    server,
    hostname,
    port: address.port,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },
  };
}

export function createDashboardRequestHandler(
  options: DashboardServerOptions,
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const hostname = options.hostname ?? "127.0.0.1";
  const snapshotTimeoutMs =
    options.snapshotTimeoutMs ?? DEFAULT_SNAPSHOT_TIMEOUT_MS;

  return async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${hostname}`);
      const method = request.method ?? "GET";

      if (url.pathname === "/") {
        if (method !== "GET") {
          writeMethodNotAllowed(response, ["GET"]);
          return;
        }

        const snapshot = await readSnapshot(options.host, snapshotTimeoutMs);
        writeHtml(response, 200, renderDashboardHtml(snapshot));
        return;
      }

      if (url.pathname === "/api/v1/state") {
        if (method !== "GET") {
          writeMethodNotAllowed(response, ["GET"]);
          return;
        }

        const snapshot = await readSnapshot(options.host, snapshotTimeoutMs);
        writeJson(response, 200, snapshot);
        return;
      }

      if (url.pathname === "/api/v1/refresh") {
        if (method !== "POST") {
          writeMethodNotAllowed(response, ["POST"]);
          return;
        }

        await readRequestBody(request);
        const refresh = await options.host.requestRefresh();
        writeJson(response, 202, refresh);
        return;
      }

      if (url.pathname.startsWith("/api/v1/")) {
        if (method !== "GET") {
          writeMethodNotAllowed(response, ["GET"]);
          return;
        }

        const issueIdentifier = decodeURIComponent(
          url.pathname.slice("/api/v1/".length),
        );
        const issue = await options.host.getIssueDetails(issueIdentifier);
        if (issue === null) {
          writeJsonError(response, 404, ERROR_CODES.issueNotFound, {
            message: `Issue '${issueIdentifier}' is not tracked in the current runtime state.`,
          });
          return;
        }

        writeJson(response, 200, issue);
        return;
      }

      writeNotFound(response, url.pathname);
    } catch (error) {
      if (isSnapshotTimeoutError(error)) {
        writeJsonError(response, 504, ERROR_CODES.snapshotTimedOut, {
          message: toErrorMessage(error),
        });
        return;
      }

      writeJsonError(response, 500, ERROR_CODES.snapshotUnavailable, {
        message: toErrorMessage(error),
      });
    }
  };
}

async function readSnapshot(
  host: DashboardServerHost,
  timeoutMs: number,
): Promise<RuntimeSnapshot> {
  return await withTimeout(host.getRuntimeSnapshot(), timeoutMs, () => {
    return new Error(`Runtime snapshot timed out after ${timeoutMs}ms.`);
  });
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", Buffer.byteLength(body));
  response.end(body);
}

function writeJsonError(
  response: ServerResponse,
  statusCode: number,
  code: string,
  input: {
    message: string;
    allow?: string[];
  },
): void {
  if (input.allow !== undefined) {
    response.setHeader("allow", input.allow.join(", "));
  }

  writeJson(response, statusCode, {
    error: {
      code,
      message: input.message,
    },
  });
}

function writeMethodNotAllowed(
  response: ServerResponse,
  allow: string[],
): void {
  writeJsonError(response, 405, "method_not_allowed", {
    message: "Method not allowed.",
    allow,
  });
}

function writeHtml(
  response: ServerResponse,
  statusCode: number,
  html: string,
): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.setHeader("content-length", Buffer.byteLength(html));
  response.end(html);
}

function writeNotFound(response: ServerResponse, path: string): void {
  response.statusCode = 404;
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.end(`Not found: ${path}`);
}

async function readRequestBody(request: IncomingMessage): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    request.on("error", reject);
    request.on("end", resolve);
    request.resume();
  });
}

async function withTimeout<T>(
  promise: Promise<T> | T,
  timeoutMs: number,
  createError: () => Error,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(createError());
    }, timeoutMs);

    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}

function isSnapshotTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith("Runtime snapshot timed out after ")
  );
}

function renderDashboardHtml(snapshot: RuntimeSnapshot): string {
  const runningRows =
    snapshot.running.length === 0
      ? '<tr><td colspan="7">No active sessions.</td></tr>'
      : snapshot.running
          .map(
            (row) => `
              <tr>
                <td>${escapeHtml(row.issue_identifier)}</td>
                <td>${escapeHtml(row.state)}</td>
                <td>${escapeHtml(row.session_id ?? "-")}</td>
                <td>${row.turn_count}</td>
                <td>${escapeHtml(row.last_event ?? "-")}</td>
                <td>${escapeHtml(row.last_message ?? "-")}</td>
                <td>${escapeHtml(row.last_event_at ?? "-")}</td>
              </tr>`,
          )
          .join("");

  const retryRows =
    snapshot.retrying.length === 0
      ? '<tr><td colspan="4">No queued retries.</td></tr>'
      : snapshot.retrying
          .map(
            (row) => `
              <tr>
                <td>${escapeHtml(row.issue_identifier ?? row.issue_id)}</td>
                <td>${row.attempt}</td>
                <td>${escapeHtml(row.due_at)}</td>
                <td>${escapeHtml(row.error ?? "-")}</td>
              </tr>`,
          )
          .join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Symphony Dashboard</title>
    <style>
      :root {
        color-scheme: light;
        font-family: ui-sans-serif, system-ui, sans-serif;
        background: #f4efe7;
        color: #1e1b18;
      }
      body {
        margin: 0;
        padding: 24px;
        background:
          radial-gradient(circle at top left, rgba(198, 110, 66, 0.16), transparent 28rem),
          linear-gradient(180deg, #f8f3eb 0%, #efe4d3 100%);
      }
      main {
        max-width: 1100px;
        margin: 0 auto;
      }
      h1, h2 {
        margin: 0 0 12px;
      }
      .grid {
        display: grid;
        gap: 16px;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        margin: 20px 0 28px;
      }
      .card, section {
        background: rgba(255, 252, 247, 0.9);
        border: 1px solid rgba(59, 44, 32, 0.12);
        border-radius: 16px;
        box-shadow: 0 10px 30px rgba(74, 46, 20, 0.08);
      }
      .card {
        padding: 18px;
      }
      .metric {
        font-size: 2rem;
        font-weight: 700;
      }
      section {
        padding: 20px;
        margin-bottom: 18px;
      }
      table {
        width: 100%;
        border-collapse: collapse;
      }
      th, td {
        text-align: left;
        padding: 10px 8px;
        border-bottom: 1px solid rgba(59, 44, 32, 0.12);
        vertical-align: top;
      }
      th {
        font-size: 0.875rem;
        color: #5f5449;
      }
      pre {
        white-space: pre-wrap;
        word-break: break-word;
        margin: 0;
      }
      .muted {
        color: #6e6256;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>Symphony Dashboard</h1>
      <p class="muted">Generated at ${escapeHtml(snapshot.generated_at)}</p>

      <div class="grid">
        <div class="card">
          <div class="muted">Running</div>
          <div class="metric">${snapshot.counts.running}</div>
        </div>
        <div class="card">
          <div class="muted">Retrying</div>
          <div class="metric">${snapshot.counts.retrying}</div>
        </div>
        <div class="card">
          <div class="muted">Input Tokens</div>
          <div class="metric">${snapshot.codex_totals.input_tokens}</div>
        </div>
        <div class="card">
          <div class="muted">Output Tokens</div>
          <div class="metric">${snapshot.codex_totals.output_tokens}</div>
        </div>
        <div class="card">
          <div class="muted">Total Tokens</div>
          <div class="metric">${snapshot.codex_totals.total_tokens}</div>
        </div>
        <div class="card">
          <div class="muted">Seconds Running</div>
          <div class="metric">${snapshot.codex_totals.seconds_running.toFixed(1)}</div>
        </div>
      </div>

      <section>
        <h2>Running Sessions</h2>
        <table>
          <thead>
            <tr>
              <th>Issue</th>
              <th>State</th>
              <th>Session</th>
              <th>Turns</th>
              <th>Last Event</th>
              <th>Last Message</th>
              <th>Last Event At</th>
            </tr>
          </thead>
          <tbody>${runningRows}</tbody>
        </table>
      </section>

      <section>
        <h2>Retry Queue</h2>
        <table>
          <thead>
            <tr>
              <th>Issue</th>
              <th>Attempt</th>
              <th>Due At</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>${retryRows}</tbody>
        </table>
      </section>

      <section>
        <h2>Rate Limits</h2>
        <pre>${escapeHtml(JSON.stringify(snapshot.rate_limits, null, 2) ?? "null")}</pre>
      </section>
    </main>
  </body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
