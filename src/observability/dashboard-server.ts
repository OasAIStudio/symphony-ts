import {
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer,
} from "node:http";

import {
  DEFAULT_OBSERVABILITY_REFRESH_MS,
  DEFAULT_OBSERVABILITY_RENDER_INTERVAL_MS,
} from "../config/defaults.js";
import { ERROR_CODES } from "../errors/codes.js";
import type { RuntimeSnapshot } from "../logging/runtime-snapshot.js";
import { toErrorMessage } from "./dashboard-format.js";
import {
  isSnapshotTimeoutError,
  readRequestBody,
  readSnapshot,
  writeHtml,
  writeJson,
  writeNotFound,
} from "./dashboard-http.js";
import { DashboardLiveUpdatesController } from "./dashboard-live-updates.js";
import {
  type DashboardRenderOptions,
  renderDashboardHtml,
} from "./dashboard-render.js";

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
  subscribeToSnapshots?(listener: () => void): () => void;
}

export interface DashboardServerOptions {
  host: DashboardServerHost;
  hostname?: string;
  snapshotTimeoutMs?: number;
  refreshMs?: number;
  renderIntervalMs?: number;
  liveUpdatesEnabled?: boolean;
}

export interface DashboardServerInstance {
  readonly server: Server;
  readonly hostname: string;
  readonly port: number;
  close(): Promise<void>;
}

export function createDashboardServer(options: DashboardServerOptions): Server {
  const hostname = options.hostname ?? "127.0.0.1";
  const snapshotTimeoutMs =
    options.snapshotTimeoutMs ?? DEFAULT_SNAPSHOT_TIMEOUT_MS;
  const liveController = new DashboardLiveUpdatesController({
    host: options.host,
    snapshotTimeoutMs,
    refreshMs: options.refreshMs ?? DEFAULT_OBSERVABILITY_REFRESH_MS,
    renderIntervalMs:
      options.renderIntervalMs ?? DEFAULT_OBSERVABILITY_RENDER_INTERVAL_MS,
  });
  liveController.start();

  const handler = createDashboardRequestHandler({
    ...options,
    hostname,
    snapshotTimeoutMs,
    liveController,
  });
  const server = createServer((request, response) => {
    void handler(request, response);
  });
  server.on("close", () => {
    void liveController.close();
  });
  return server;
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
  options: DashboardServerOptions & {
    liveController?: DashboardLiveUpdatesController;
  },
): (request: IncomingMessage, response: ServerResponse) => Promise<void> {
  const hostname = options.hostname ?? "127.0.0.1";
  const snapshotTimeoutMs =
    options.snapshotTimeoutMs ?? DEFAULT_SNAPSHOT_TIMEOUT_MS;
  const renderOptions: DashboardRenderOptions = {
    liveUpdatesEnabled: options.liveUpdatesEnabled ?? true,
  };

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
        writeHtml(response, 200, renderDashboardHtml(snapshot, renderOptions));
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

      if (url.pathname === "/api/v1/events") {
        if (method !== "GET") {
          writeMethodNotAllowed(response, ["GET"]);
          return;
        }

        if (renderOptions.liveUpdatesEnabled !== true) {
          writeNotFound(response, url.pathname);
          return;
        }

        if (options.liveController === undefined) {
          writeJsonError(response, 503, ERROR_CODES.snapshotUnavailable, {
            message: "Live dashboard updates are unavailable.",
          });
          return;
        }

        await options.liveController.handleEventsRequest(request, response);
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
