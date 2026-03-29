import {
  type ChildProcess,
  execFile as execFileCb,
  spawn,
} from "node:child_process";
import {
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer,
} from "node:http";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";

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
const GITHUB_QUEUE_CACHE_TTL_MS = 15_000;

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
  parent: {
    identifier: string;
    title: string;
    url: string;
  } | null;
}

export interface RefreshResponse {
  queued: boolean;
  coalesced: boolean;
  requested_at: string;
  operations: string[];
}

export interface StopIssueResponse {
  issue_identifier: string;
  stopped: boolean;
  reason: string;
}

export interface DashboardServerHost {
  getRuntimeSnapshot(): RuntimeSnapshot | Promise<RuntimeSnapshot>;
  getIssueDetails(
    issueIdentifier: string,
  ): IssueDetailResponse | null | Promise<IssueDetailResponse | null>;
  requestRefresh(): RefreshResponse | Promise<RefreshResponse>;
  requestIssueStop?(
    issueIdentifier: string,
  ): StopIssueResponse | Promise<StopIssueResponse>;
  subscribeToSnapshots?(listener: () => void): () => void;
}

/** Async function that runs `gh` with the given args and returns stdout. */
export type ExecGh = (args: string[]) => Promise<string>;

/** Async function that runs the deploy script with the given args and returns stdout. */
export type ExecDeploy = (args: string[]) => Promise<string>;

/** Spawns the deploy script with the given args and returns the child process for streaming. */
export type SpawnDeploy = (args: string[]) => ChildProcess;

export interface DeployPreviewResponse {
  current_version: string;
  target_version: string;
  commits_ahead: number;
  actions: string[];
  running_issues_count: number;
}

export interface DashboardServerOptions {
  host: DashboardServerHost;
  hostname?: string;
  snapshotTimeoutMs?: number;
  refreshMs?: number;
  renderIntervalMs?: number;
  liveUpdatesEnabled?: boolean;
  /** GitHub repo slug (e.g. "org/repo"). Falls back to REPO_URL env var. */
  githubRepoSlug?: string;
  /** Injectable gh CLI executor for testing. Defaults to child_process.execFile("gh", ...). */
  execGh?: ExecGh;
  /** Injectable deploy script executor for testing. Defaults to running ops/symphony-deploy. */
  execDeploy?: ExecDeploy;
  /** Injectable deploy script spawner for streaming. Defaults to spawning ops/symphony-deploy. */
  spawnDeploy?: SpawnDeploy;
}

export interface DashboardServerInstance {
  readonly server: Server;
  readonly hostname: string;
  readonly port: number;
  close(): Promise<void>;
}

export function createDashboardServer(options: DashboardServerOptions): Server {
  const hostname = options.hostname ?? "0.0.0.0";
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
  const hostname = options.hostname ?? "0.0.0.0";

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
  const hostname = options.hostname ?? "0.0.0.0";
  const snapshotTimeoutMs =
    options.snapshotTimeoutMs ?? DEFAULT_SNAPSHOT_TIMEOUT_MS;
  const renderOptions: DashboardRenderOptions = {
    liveUpdatesEnabled: options.liveUpdatesEnabled ?? true,
  };
  const githubRepoSlug = resolveRepoSlug(options.githubRepoSlug);
  const execGh = options.execGh ?? defaultExecGh;
  const execDeploy = options.execDeploy ?? defaultExecDeploy;
  const spawnDeployFn = options.spawnDeploy ?? defaultSpawnDeploy;
  let githubQueueCache: GitHubQueueCache | null = null;

  return async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${hostname}`);
      const method = request.method ?? "GET";

      // CORS headers on all responses
      response.setHeader("access-control-allow-origin", "*");
      response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
      response.setHeader(
        "access-control-allow-headers",
        "Content-Type, Authorization",
      );

      // Handle CORS preflight
      if (method === "OPTIONS") {
        response.statusCode = 204;
        response.end();
        return;
      }

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

      if (url.pathname === "/api/v1/deploy/preview") {
        if (method !== "POST") {
          writeMethodNotAllowed(response, ["POST"]);
          return;
        }

        await readRequestBody(request);

        try {
          const snapshot = await readSnapshot(options.host, snapshotTimeoutMs);
          const runningCount = snapshot.counts.running;

          const stdout = await execDeploy(["--dry-run"]);
          const preview = parseDeployDryRunOutput(stdout, runningCount);
          writeJson(response, 200, preview);
        } catch (error) {
          writeJsonError(response, 500, ERROR_CODES.deployFailed, {
            message:
              error instanceof Error ? error.message : "Deploy preview failed.",
          });
        }
        return;
      }

      if (url.pathname === "/api/v1/deploy") {
        if (method !== "POST") {
          writeMethodNotAllowed(response, ["POST"]);
          return;
        }

        await readRequestBody(request);

        response.statusCode = 200;
        response.setHeader("content-type", "text/event-stream");
        response.setHeader("cache-control", "no-cache");
        response.setHeader("connection", "keep-alive");
        response.flushHeaders();

        try {
          await streamDeploy(response, spawnDeployFn);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Deploy failed.";
          writeSseEvent(response, "deploy_complete", {
            success: false,
            message,
          });
          response.end();
        }
        return;
      }

      if (url.pathname === "/api/v1/github/queue") {
        if (method !== "GET") {
          writeMethodNotAllowed(response, ["GET"]);
          return;
        }

        if (githubRepoSlug === null) {
          writeJsonError(response, 500, ERROR_CODES.githubCliFailed, {
            message:
              "GitHub repo slug is not configured. Set githubRepoSlug in options or REPO_URL environment variable.",
          });
          return;
        }

        // Return cached response if still valid
        if (
          githubQueueCache !== null &&
          Date.now() < githubQueueCache.expiresAt
        ) {
          writeJson(response, 200, { ...githubQueueCache.data, cached: true });
          return;
        }

        try {
          const data = await fetchGitHubQueue(githubRepoSlug, execGh);
          githubQueueCache = {
            data,
            expiresAt: Date.now() + GITHUB_QUEUE_CACHE_TTL_MS,
          };
          writeJson(response, 200, data);
        } catch (error) {
          writeJsonError(response, 502, ERROR_CODES.githubCliFailed, {
            message:
              error instanceof Error
                ? error.message
                : "GitHub CLI command failed.",
          });
        }
        return;
      }

      if (url.pathname.startsWith("/api/v1/")) {
        const rest = url.pathname.slice("/api/v1/".length);
        const stopMatch = rest.match(/^(.+)\/stop$/);

        if (stopMatch !== null) {
          if (method !== "POST") {
            writeMethodNotAllowed(response, ["POST"]);
            return;
          }

          const issueIdentifier = decodeURIComponent(stopMatch[1] ?? "");

          if (options.host.requestIssueStop === undefined) {
            writeJsonError(response, 501, "not_implemented", {
              message: "Stop issue is not supported by this host.",
            });
            return;
          }

          await readRequestBody(request);
          const result = await options.host.requestIssueStop(issueIdentifier);
          writeJson(response, result.stopped ? 200 : 404, result);
          return;
        }

        if (method !== "GET") {
          writeMethodNotAllowed(response, ["GET"]);
          return;
        }

        const issueIdentifier = decodeURIComponent(rest);
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

// ── GitHub merge queue types & helpers ────────────────────────────

export interface GitHubQueuePR {
  number: number;
  title: string;
  url: string;
  author: string;
  state: string;
  mergedAt: string | null;
  labels: string[];
}

export interface GitHubQueueAlert {
  number: number;
  title: string;
  url: string;
  createdAt: string;
}

export interface GitHubQueueResponse {
  repo: string;
  cached: boolean;
  fetched_at: string;
  in_queue: GitHubQueuePR[];
  recently_merged: GitHubQueuePR[];
  rejected: GitHubQueuePR[];
  alerts: GitHubQueueAlert[];
}

interface GitHubQueueCache {
  data: GitHubQueueResponse;
  expiresAt: number;
}

function resolveRepoSlug(explicit?: string): string | null {
  if (explicit !== undefined && explicit !== "") {
    return explicit;
  }
  const repoUrl = process.env.REPO_URL;
  if (repoUrl === undefined || repoUrl === "") {
    return null;
  }
  // Extract owner/repo from https://github.com/owner/repo(.git)
  return repoUrl.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
}

interface GhPrJsonItem {
  number: number;
  title: string;
  url: string;
  author: { login: string };
  state: string;
  mergedAt: string | null;
  labels: Array<{ name: string }>;
}

interface GhIssueJsonItem {
  number: number;
  title: string;
  url: string;
  createdAt: string;
}

function categorizePRs(prs: GhPrJsonItem[]): {
  in_queue: GitHubQueuePR[];
  recently_merged: GitHubQueuePR[];
  rejected: GitHubQueuePR[];
} {
  const in_queue: GitHubQueuePR[] = [];
  const recently_merged: GitHubQueuePR[] = [];
  const rejected: GitHubQueuePR[] = [];

  for (const pr of prs) {
    const mapped: GitHubQueuePR = {
      number: pr.number,
      title: pr.title,
      url: pr.url,
      author: pr.author.login,
      state: pr.state,
      mergedAt: pr.mergedAt,
      labels: pr.labels.map((l) => l.name),
    };

    if (pr.state === "MERGED") {
      recently_merged.push(mapped);
    } else if (pr.state === "CLOSED") {
      rejected.push(mapped);
    } else {
      // OPEN PRs are considered in the queue
      in_queue.push(mapped);
    }
  }

  return { in_queue, recently_merged, rejected };
}

function defaultExecGh(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFileCb(
      "gh",
      args,
      { encoding: "utf-8", maxBuffer: 2 * 1024 * 1024, timeout: 15_000 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function fetchGitHubQueue(
  repoSlug: string,
  execGh: ExecGh,
): Promise<GitHubQueueResponse> {
  const prFields = "number,title,url,author,state,mergedAt,labels";

  const prStdout = await execGh([
    "pr",
    "list",
    "--repo",
    repoSlug,
    "--json",
    prFields,
    "--limit",
    "50",
    "--state",
    "all",
  ]);

  const prs = JSON.parse(prStdout) as GhPrJsonItem[];
  const { in_queue, recently_merged, rejected } = categorizePRs(prs);

  let alerts: GitHubQueueAlert[] = [];
  try {
    const issueStdout = await execGh([
      "issue",
      "list",
      "--repo",
      repoSlug,
      "--json",
      "number,title,url,createdAt",
      "--label",
      "pipeline-halt",
      "--limit",
      "20",
    ]);
    const issues = JSON.parse(issueStdout) as GhIssueJsonItem[];
    alerts = issues.map((issue) => ({
      number: issue.number,
      title: issue.title,
      url: issue.url,
      createdAt: issue.createdAt,
    }));
  } catch {
    // Issues may be disabled on the repo — return PR data with empty alerts
  }

  return {
    repo: repoSlug,
    cached: false,
    fetched_at: new Date().toISOString(),
    in_queue,
    recently_merged,
    rejected,
    alerts,
  };
}

// ── Deploy types & helpers ────────────────────────────────────────

export function resolveDeployScriptPath(): string {
  const thisFile = fileURLToPath(import.meta.url);
  // dist/src/observability/dashboard-server.js -> repo root (3 levels up) -> ops/symphony-deploy
  const repoRoot = pathResolve(dirname(thisFile), "..", "..", "..");
  return pathResolve(repoRoot, "ops", "symphony-deploy");
}

function defaultExecDeploy(args: string[]): Promise<string> {
  const scriptPath = resolveDeployScriptPath();
  return new Promise((resolve, reject) => {
    execFileCb(
      scriptPath,
      args,
      { encoding: "utf-8", maxBuffer: 2 * 1024 * 1024, timeout: 120_000 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function defaultSpawnDeploy(args: string[]): ChildProcess {
  const scriptPath = resolveDeployScriptPath();
  return spawn(scriptPath, args, { stdio: ["ignore", "pipe", "pipe"] });
}

function parseDeployDryRunOutput(
  stdout: string,
  runningIssuesCount: number,
): DeployPreviewResponse {
  const lines = stdout.split("\n");

  let currentVersion = "(unknown)";
  let targetVersion = "(unknown)";
  let commitsAhead = 0;
  const actions: string[] = [];

  for (const line of lines) {
    // Strip ANSI escape codes for parsing
    // biome-ignore lint/suspicious/noControlCharactersInRegex: ESC char needed to strip ANSI codes
    const clean = line.replace(/\u001b\[[0-9;]*m/g, "").trim();

    // Match "Pre-deploy version: <version>"
    const preVersionMatch = clean.match(/Pre-deploy version:\s*(.+)/);
    if (preVersionMatch?.[1] !== undefined) {
      currentVersion = preVersionMatch[1].trim();
    }

    // Match "Post-deploy version: <version>"
    const postVersionMatch = clean.match(/Post-deploy version:\s*(.+)/);
    if (postVersionMatch?.[1] !== undefined) {
      targetVersion = postVersionMatch[1].trim();
    }

    // Match "symphony-ts: <pre_sha> → <post_sha>" from summary
    const shaMatch = clean.match(
      /symphony-ts:\s+([a-f0-9]+)\s+→\s+([a-f0-9]+)/,
    );
    if (shaMatch?.[1] !== undefined && shaMatch[2] !== undefined) {
      if (shaMatch[1] !== shaMatch[2]) {
        // Count commits between SHAs — dry-run doesn't give exact count,
        // but we mark at least 1 if SHAs differ
        commitsAhead = 1;
      }
    }

    // Collect [dry-run] action lines
    const dryRunMatch = clean.match(/\[dry-run\]\s+(.+)/);
    if (dryRunMatch?.[1] !== undefined) {
      actions.push(dryRunMatch[1].trim());
    }
  }

  return {
    current_version: currentVersion,
    target_version: targetVersion,
    commits_ahead: commitsAhead,
    actions,
    running_issues_count: runningIssuesCount,
  };
}

function writeSseEvent(
  response: ServerResponse,
  event: string,
  data: unknown,
): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

async function streamDeploy(
  response: ServerResponse,
  spawnDeployFn: SpawnDeploy,
): Promise<void> {
  return await new Promise<void>((resolve, reject) => {
    const child = spawnDeployFn([]);
    let buffer = "";
    let errBuffer = "";

    const flushLine = (line: string) => {
      writeSseEvent(response, "deploy_output", { line });
    };

    child.stdout?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk: string) => {
      buffer += chunk;
      const parts = buffer.split("\n");
      // Keep the last partial line in the buffer
      buffer = parts.pop() ?? "";
      for (const part of parts) {
        flushLine(part);
      }
    });

    child.stderr?.setEncoding("utf-8");
    child.stderr?.on("data", (chunk: string) => {
      errBuffer += chunk;
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      // Flush any remaining buffer
      if (buffer.length > 0) {
        flushLine(buffer);
        buffer = "";
      }

      const success = code === 0;
      writeSseEvent(response, "deploy_complete", {
        success,
        exit_code: code,
        message: success
          ? "Deploy completed successfully."
          : `Deploy failed with exit code ${code}.${errBuffer.length > 0 ? ` stderr: ${errBuffer.trim()}` : ""}`,
      });
      response.end();
      resolve();
    });
  });
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
