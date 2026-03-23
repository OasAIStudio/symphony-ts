import type {
  CodexRateLimits,
  CodexTotals,
  OrchestratorState,
  RecentActivityEntry,
  StageRecord,
  TurnHistoryEntry,
} from "../domain/model.js";
import { formatEasternTimestamp } from "./format-timestamp.js";
import { getAggregateSecondsRunning } from "./session-metrics.js";

export type HealthStatus = "green" | "yellow" | "red";

export interface RuntimeSnapshotRunningRow {
  issue_id: string;
  issue_identifier: string;
  issue_title: string;
  state: string;
  pipeline_stage: string | null;
  activity_summary: string | null;
  session_id: string | null;
  turn_count: number;
  last_event: string | null;
  last_message: string | null;
  started_at: string;
  first_dispatched_at: string;
  last_event_at: string | null;
  stage_duration_seconds: number;
  tokens_per_turn: number;
  tokens: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    cache_read_tokens: number;
    cache_write_tokens: number;
    reasoning_tokens: number;
  };
  rework_count?: number;
  total_pipeline_tokens: number;
  execution_history: StageRecord[];
  turn_history: TurnHistoryEntry[];
  recent_activity: RecentActivityEntry[];
  health: HealthStatus;
  health_reason: string | null;
}

export interface RuntimeSnapshotRetryRow {
  issue_id: string;
  issue_identifier: string | null;
  attempt: number;
  due_at: string;
  error: string | null;
}

export interface RuntimeSnapshot {
  generated_at: string;
  counts: {
    running: number;
    retrying: number;
    completed: number;
    failed: number;
  };
  running: RuntimeSnapshotRunningRow[];
  retrying: RuntimeSnapshotRetryRow[];
  codex_totals: {
    input_tokens: number;
    output_tokens: number;
    total_tokens: number;
    seconds_running: number;
  };
  rate_limits: CodexRateLimits;
}

export function buildRuntimeSnapshot(
  state: OrchestratorState,
  options?: {
    now?: Date;
  },
): RuntimeSnapshot {
  const now = options?.now ?? new Date();

  const running = Object.values(state.running)
    .slice()
    .sort((left, right) =>
      left.identifier.localeCompare(right.identifier, "en"),
    )
    .map((entry) => {
      const reworkCount = state.issueReworkCounts[entry.issue.id] ?? 0;
      const startedAtMs = Date.parse(entry.startedAt);
      const stageDurationSeconds = Number.isFinite(startedAtMs)
        ? Math.max(0, (now.getTime() - startedAtMs) / 1000)
        : 0;
      const tokensPerTurn =
        entry.turnCount > 0 ? entry.totalStageTotalTokens / entry.turnCount : 0;
      const executionHistory =
        state.issueExecutionHistory[entry.issue.id] ?? [];
      const completedStageTokens = executionHistory.reduce(
        (sum, stage) => sum + stage.totalTokens,
        0,
      );
      const totalPipelineTokens =
        completedStageTokens + entry.totalStageTotalTokens;
      const { health, health_reason } = classifyHealth(
        entry.lastCodexTimestamp,
        tokensPerTurn,
        now,
      );
      const row: RuntimeSnapshotRunningRow = {
        issue_id: entry.issue.id,
        issue_identifier: entry.identifier,
        issue_title: entry.issue.title,
        state: entry.issue.state,
        pipeline_stage: state.issueStages[entry.issue.id] ?? null,
        activity_summary: entry.lastCodexMessage,
        session_id: entry.sessionId,
        turn_count: entry.turnCount,
        last_event: entry.lastCodexEvent,
        last_message: entry.lastCodexMessage,
        started_at: entry.startedAt,
        first_dispatched_at:
          state.issueFirstDispatchedAt[entry.issue.id] ?? entry.startedAt,
        last_event_at:
          entry.lastCodexTimestamp !== null
            ? formatEasternTimestamp(new Date(entry.lastCodexTimestamp))
            : null,
        stage_duration_seconds: stageDurationSeconds,
        tokens_per_turn: tokensPerTurn,
        tokens: {
          input_tokens: entry.totalStageInputTokens,
          output_tokens: entry.totalStageOutputTokens,
          total_tokens: entry.totalStageTotalTokens,
          cache_read_tokens: entry.totalStageCacheReadTokens,
          cache_write_tokens: entry.totalStageCacheWriteTokens,
          reasoning_tokens: entry.codexReasoningTokens,
        },
        total_pipeline_tokens: totalPipelineTokens,
        execution_history: executionHistory,
        turn_history: entry.turnHistory,
        recent_activity: entry.recentActivity,
        health,
        health_reason,
      };
      if (reworkCount > 0) {
        row.rework_count = reworkCount;
      }
      return row;
    });

  const retrying = Object.values(state.retryAttempts)
    .slice()
    .sort((left, right) => left.dueAtMs - right.dueAtMs)
    .map((entry) => ({
      issue_id: entry.issueId,
      issue_identifier: entry.identifier,
      attempt: entry.attempt,
      due_at: formatEasternTimestamp(new Date(entry.dueAtMs)),
      error: entry.error,
    }));

  return {
    generated_at: formatEasternTimestamp(now),
    counts: {
      running: running.length,
      retrying: retrying.length,
      completed: state.completed.size,
      failed: state.failed.size,
    },
    running,
    retrying,
    codex_totals: toSnapshotCodexTotals(
      state.codexTotals,
      getAggregateSecondsRunning(state, now),
    ),
    rate_limits: state.codexRateLimits,
  };
}

function toSnapshotCodexTotals(
  totals: CodexTotals,
  secondsRunning: number,
): RuntimeSnapshot["codex_totals"] {
  return {
    input_tokens: totals.inputTokens,
    output_tokens: totals.outputTokens,
    total_tokens: totals.totalTokens,
    seconds_running: secondsRunning,
  };
}

const STALL_THRESHOLD_SECONDS = 120;
const HIGH_TOKEN_BURN_THRESHOLD = 20_000;

function classifyHealth(
  lastEventAt: string | null,
  tokensPerTurn: number,
  now: Date,
): { health: HealthStatus; health_reason: string | null } {
  if (lastEventAt !== null) {
    const lastEventMs = Date.parse(lastEventAt);
    if (Number.isFinite(lastEventMs)) {
      const secondsSinceEvent = (now.getTime() - lastEventMs) / 1000;
      if (secondsSinceEvent > STALL_THRESHOLD_SECONDS) {
        return {
          health: "red",
          health_reason: `stalled: no activity for ${Math.floor(secondsSinceEvent)}s`,
        };
      }
    }
  }

  if (tokensPerTurn > HIGH_TOKEN_BURN_THRESHOLD) {
    return {
      health: "yellow",
      health_reason: `high token burn: ${Math.round(tokensPerTurn).toLocaleString("en-US")} tokens/turn`,
    };
  }

  return { health: "green", health_reason: null };
}
