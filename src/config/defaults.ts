import { tmpdir } from "node:os";
import { join } from "node:path";

export const DEFAULT_LINEAR_ENDPOINT = "https://api.linear.app/graphql";
export const DEFAULT_TRACKER_KIND = "linear";
export const DEFAULT_ACTIVE_STATES = ["Todo", "In Progress"] as const;
export const DEFAULT_TERMINAL_STATES = [
  "Closed",
  "Cancelled",
  "Canceled",
  "Duplicate",
  "Done",
] as const;

export const DEFAULT_POLL_INTERVAL_MS = 30_000;
export const DEFAULT_WORKSPACE_ROOT = join(tmpdir(), "symphony_workspaces");
export const DEFAULT_HOOK_TIMEOUT_MS = 60_000;

export const DEFAULT_MAX_CONCURRENT_AGENTS = 10;
export const DEFAULT_MAX_TURNS = 20;
export const DEFAULT_MAX_RETRY_BACKOFF_MS = 300_000;
export const DEFAULT_MAX_RETRY_ATTEMPTS = 5;
export const DEFAULT_MAX_CONCURRENT_AGENTS_BY_STATE = Object.freeze(
  {},
) as Readonly<Record<string, number>>;

export const DEFAULT_RUNNER_KIND = "codex";

export const DEFAULT_CODEX_COMMAND = "codex app-server";
export const DEFAULT_TURN_TIMEOUT_MS = 3_600_000;
export const DEFAULT_READ_TIMEOUT_MS = 5_000;
export const DEFAULT_STALL_TIMEOUT_MS = 300_000;
export const DEFAULT_OBSERVABILITY_ENABLED = true;
export const DEFAULT_OBSERVABILITY_REFRESH_MS = 1_000;
export const DEFAULT_OBSERVABILITY_RENDER_INTERVAL_MS = 16;

export const DEFAULT_LINEAR_PAGE_SIZE = 50;
export const DEFAULT_LINEAR_NETWORK_TIMEOUT_MS = 30_000;

export const WORKFLOW_FILENAME = "WORKFLOW.md";

export const SPEC_DEFAULTS = Object.freeze({
  tracker: {
    kind: DEFAULT_TRACKER_KIND,
    endpoint: DEFAULT_LINEAR_ENDPOINT,
    activeStates: DEFAULT_ACTIVE_STATES,
    terminalStates: DEFAULT_TERMINAL_STATES,
    pageSize: DEFAULT_LINEAR_PAGE_SIZE,
    networkTimeoutMs: DEFAULT_LINEAR_NETWORK_TIMEOUT_MS,
  },
  polling: {
    intervalMs: DEFAULT_POLL_INTERVAL_MS,
  },
  workspace: {
    root: DEFAULT_WORKSPACE_ROOT,
  },
  hooks: {
    timeoutMs: DEFAULT_HOOK_TIMEOUT_MS,
  },
  agent: {
    maxConcurrentAgents: DEFAULT_MAX_CONCURRENT_AGENTS,
    maxTurns: DEFAULT_MAX_TURNS,
    maxRetryBackoffMs: DEFAULT_MAX_RETRY_BACKOFF_MS,
    maxRetryAttempts: DEFAULT_MAX_RETRY_ATTEMPTS,
    maxConcurrentAgentsByState: DEFAULT_MAX_CONCURRENT_AGENTS_BY_STATE,
  },
  runner: {
    kind: DEFAULT_RUNNER_KIND,
  },
  codex: {
    command: DEFAULT_CODEX_COMMAND,
    turnTimeoutMs: DEFAULT_TURN_TIMEOUT_MS,
    readTimeoutMs: DEFAULT_READ_TIMEOUT_MS,
    stallTimeoutMs: DEFAULT_STALL_TIMEOUT_MS,
  },
  observability: {
    dashboardEnabled: DEFAULT_OBSERVABILITY_ENABLED,
    refreshMs: DEFAULT_OBSERVABILITY_REFRESH_MS,
    renderIntervalMs: DEFAULT_OBSERVABILITY_RENDER_INTERVAL_MS,
  },
} as const);
