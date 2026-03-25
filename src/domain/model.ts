export const ORCHESTRATOR_ISSUE_STATUSES = [
  "unclaimed",
  "claimed",
  "running",
  "retry_queued",
  "released",
] as const;

export type OrchestratorIssueStatus =
  (typeof ORCHESTRATOR_ISSUE_STATUSES)[number];

export const RUN_ATTEMPT_PHASES = [
  "preparing_workspace",
  "building_prompt",
  "launching_agent_process",
  "initializing_session",
  "streaming_turn",
  "finishing",
  "succeeded",
  "failed",
  "timed_out",
  "stalled",
  "canceled_by_reconciliation",
] as const;

export type RunAttemptPhase = (typeof RUN_ATTEMPT_PHASES)[number];

export const ORCHESTRATOR_EVENTS = [
  "poll_tick",
  "poll_tick_completed",
  "worker_exit_normal",
  "worker_exit_abnormal",
  "stage_completed",
  "codex_update_event",
  "retry_timer_fired",
  "reconciliation_state_refresh",
  "stall_timeout",
  "shutdown_complete",
] as const;

export type OrchestratorEvent = (typeof ORCHESTRATOR_EVENTS)[number];

export interface BlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: string;
  branchName: string | null;
  url: string | null;
  labels: string[];
  blockedBy: BlockerRef[];
  createdAt: string | null;
  updatedAt: string | null;
}

export interface WorkflowDefinition {
  config: Record<string, unknown>;
  promptTemplate: string;
}

export interface Workspace {
  path: string;
  workspaceKey: string;
  createdNow: boolean;
}

export interface RunAttempt {
  issueId: string;
  issueIdentifier: string;
  attempt: number | null;
  workspacePath: string;
  startedAt: string;
  status: RunAttemptPhase;
  error?: string;
}

export interface TurnHistoryEntry {
  turnNumber: number;
  timestamp: string;
  message: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  event: string | null;
}

export interface RecentActivityEntry {
  timestamp: string;
  toolName: string;
  context: string | null;
  totalTokens?: number;
}

export interface LiveSession {
  sessionId: string | null;
  threadId: string | null;
  turnId: string | null;
  codexAppServerPid: string | null;
  lastCodexEvent: string | null;
  lastCodexTimestamp: string | null;
  lastCodexMessage: string | null;
  codexInputTokens: number;
  codexOutputTokens: number;
  codexTotalTokens: number;
  codexCacheReadTokens: number;
  codexCacheWriteTokens: number;
  codexNoCacheTokens: number;
  codexReasoningTokens: number;
  codexTotalInputTokens: number;
  codexTotalOutputTokens: number;
  lastReportedInputTokens: number;
  lastReportedOutputTokens: number;
  lastReportedTotalTokens: number;
  turnCount: number;
  totalStageInputTokens: number;
  totalStageOutputTokens: number;
  totalStageTotalTokens: number;
  totalStageCacheReadTokens: number;
  totalStageCacheWriteTokens: number;
  turnHistory: TurnHistoryEntry[];
  recentActivity: RecentActivityEntry[];
}

export interface RetryEntry {
  issueId: string;
  identifier: string | null;
  attempt: number;
  dueAtMs: number;
  timerHandle: ReturnType<typeof setTimeout> | null;
  error: string | null;
  delayType: "continuation" | "failure";
}

export interface CodexTotals {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  noCacheTokens: number;
  reasoningTokens: number;
  secondsRunning: number;
}

export type CodexRateLimits = Record<string, unknown> | null;

export interface RunningEntry extends LiveSession {
  issue: Issue;
  identifier: string;
  retryAttempt: number | null;
  startedAt: string;
  workerHandle: unknown;
  monitorHandle: unknown;
}

export interface StageRecord {
  stageName: string;
  durationMs: number;
  totalTokens: number;
  inputTokens?: number;
  outputTokens?: number;
  turns: number;
  outcome: string;
}

export type ExecutionHistory = StageRecord[];

export interface OrchestratorState {
  pollIntervalMs: number;
  maxConcurrentAgents: number;
  running: Record<string, RunningEntry>;
  claimed: Set<string>;
  retryAttempts: Record<string, RetryEntry>;
  completed: Set<string>;
  failed: Set<string>;
  codexTotals: CodexTotals;
  codexRateLimits: CodexRateLimits;
  issueStages: Record<string, string>;
  issueReworkCounts: Record<string, number>;
  issueFirstDispatchedAt: Record<string, string>;
  issueExecutionHistory: Record<string, ExecutionHistory>;
}

export const FAILURE_CLASSES = [
  "verify",
  "review",
  "rebase",
  "spec",
  "infra",
] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

export interface FailureSignal {
  failureClass: FailureClass;
}

const STAGE_FAILED_REGEX =
  /\[STAGE_FAILED:\s*(verify|review|rebase|spec|infra)\s*\]/;

/**
 * Parse a `[STAGE_FAILED: class]` signal from agent output text.
 * Returns the parsed failure signal or null if no signal is found.
 */
export function parseFailureSignal(
  text: string | null | undefined,
): FailureSignal | null {
  if (text === null || text === undefined) {
    return null;
  }
  const match = STAGE_FAILED_REGEX.exec(text);
  if (match === null) {
    return null;
  }
  return { failureClass: match[1] as FailureClass };
}

export function normalizeIssueState(state: string): string {
  return state.trim().toLowerCase();
}

export function toWorkspaceKey(issueIdentifier: string): string {
  return issueIdentifier.replaceAll(/[^A-Za-z0-9._-]/g, "_");
}

export function toSessionId(threadId: string, turnId: string): string {
  return `${threadId}-${turnId}`;
}

export function createEmptyLiveSession(): LiveSession {
  return {
    sessionId: null,
    threadId: null,
    turnId: null,
    codexAppServerPid: null,
    lastCodexEvent: null,
    lastCodexTimestamp: null,
    lastCodexMessage: null,
    codexInputTokens: 0,
    codexOutputTokens: 0,
    codexTotalTokens: 0,
    codexCacheReadTokens: 0,
    codexCacheWriteTokens: 0,
    codexNoCacheTokens: 0,
    codexReasoningTokens: 0,
    codexTotalInputTokens: 0,
    codexTotalOutputTokens: 0,
    lastReportedInputTokens: 0,
    lastReportedOutputTokens: 0,
    lastReportedTotalTokens: 0,
    turnCount: 0,
    totalStageInputTokens: 0,
    totalStageOutputTokens: 0,
    totalStageTotalTokens: 0,
    totalStageCacheReadTokens: 0,
    totalStageCacheWriteTokens: 0,
    turnHistory: [],
    recentActivity: [],
  };
}

export function createInitialOrchestratorState(input: {
  pollIntervalMs: number;
  maxConcurrentAgents: number;
}): OrchestratorState {
  return {
    pollIntervalMs: input.pollIntervalMs,
    maxConcurrentAgents: input.maxConcurrentAgents,
    running: {},
    claimed: new Set<string>(),
    retryAttempts: {},
    completed: new Set<string>(),
    failed: new Set<string>(),
    codexTotals: {
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      noCacheTokens: 0,
      reasoningTokens: 0,
      secondsRunning: 0,
    },
    codexRateLimits: null,
    issueStages: {},
    issueReworkCounts: {},
    issueFirstDispatchedAt: {},
    issueExecutionHistory: {},
  };
}
