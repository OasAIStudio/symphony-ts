import type { CodexClientEvent } from "../codex/app-server-client.js";
import type {
  LiveSession,
  OrchestratorState,
  RunningEntry,
} from "../domain/model.js";

const SESSION_EVENT_MESSAGES: Partial<
  Record<CodexClientEvent["event"], string>
> = Object.freeze({
  session_started: "session started",
  startup_failed: "startup failed",
  turn_completed: "turn completed",
  turn_failed: "turn failed",
  turn_cancelled: "turn cancelled",
  turn_ended_with_error: "turn ended with error",
  turn_input_required: "operator input required",
  approval_auto_approved: "approval auto approved",
  unsupported_tool_call: "unsupported tool call",
  notification: "notification",
  other_message: "other message",
  malformed: "malformed event",
  activity_heartbeat: "activity heartbeat",
});

export interface SessionTelemetryUpdateResult {
  inputTokensDelta: number;
  outputTokensDelta: number;
  totalTokensDelta: number;
  cacheReadTokensDelta: number;
  cacheWriteTokensDelta: number;
  noCacheTokensDelta: number;
  reasoningTokensDelta: number;
  rateLimitsUpdated: boolean;
}

export function applyCodexEventToSession(
  session: LiveSession,
  event: CodexClientEvent,
): SessionTelemetryUpdateResult {
  if (event.sessionId !== undefined) {
    session.sessionId = event.sessionId;
  }
  if (event.threadId !== undefined) {
    session.threadId = event.threadId;
  }
  if (event.turnId !== undefined) {
    session.turnId = event.turnId;
  }
  session.codexAppServerPid = event.codexAppServerPid;
  session.lastCodexEvent = event.event;
  session.lastCodexTimestamp = event.timestamp;
  session.lastCodexMessage = summarizeCodexEvent(event);

  if (event.event === "session_started") {
    session.turnCount += 1;
    // Reset per-turn absolute counters so the next turn's deltas accumulate from 0
    session.lastReportedInputTokens = 0;
    session.lastReportedOutputTokens = 0;
    session.lastReportedTotalTokens = 0;
  }

  if (event.usage === undefined) {
    return {
      inputTokensDelta: 0,
      outputTokensDelta: 0,
      totalTokensDelta: 0,
      cacheReadTokensDelta: 0,
      cacheWriteTokensDelta: 0,
      noCacheTokensDelta: 0,
      reasoningTokensDelta: 0,
      rateLimitsUpdated: event.rateLimits !== undefined,
    };
  }

  const inputTokens = normalizeAbsoluteCounter(event.usage.inputTokens);
  const outputTokens = normalizeAbsoluteCounter(event.usage.outputTokens);
  const totalTokens = normalizeAbsoluteCounter(event.usage.totalTokens);

  const inputTokensDelta = computeCounterDelta(
    session.lastReportedInputTokens,
    inputTokens,
  );
  const outputTokensDelta = computeCounterDelta(
    session.lastReportedOutputTokens,
    outputTokens,
  );
  const totalTokensDelta = computeCounterDelta(
    session.lastReportedTotalTokens,
    totalTokens,
  );

  const cacheReadTokensDelta =
    event.usage.cacheReadTokens !== undefined
      ? normalizeAbsoluteCounter(event.usage.cacheReadTokens)
      : 0;
  const cacheWriteTokensDelta =
    event.usage.cacheWriteTokens !== undefined
      ? normalizeAbsoluteCounter(event.usage.cacheWriteTokens)
      : 0;
  const noCacheTokensDelta =
    event.usage.noCacheTokens !== undefined
      ? normalizeAbsoluteCounter(event.usage.noCacheTokens)
      : 0;
  const reasoningTokensDelta =
    event.usage.reasoningTokens !== undefined
      ? normalizeAbsoluteCounter(event.usage.reasoningTokens)
      : 0;

  session.codexInputTokens = inputTokens;
  session.codexOutputTokens = outputTokens;
  session.codexTotalTokens = totalTokens;
  session.codexCacheReadTokens += cacheReadTokensDelta;
  session.codexCacheWriteTokens += cacheWriteTokensDelta;
  session.codexNoCacheTokens += noCacheTokensDelta;
  session.codexReasoningTokens += reasoningTokensDelta;
  session.codexTotalInputTokens += inputTokensDelta;
  session.codexTotalOutputTokens += outputTokensDelta;
  session.totalStageInputTokens += inputTokensDelta;
  session.totalStageOutputTokens += outputTokensDelta;
  session.totalStageTotalTokens += totalTokensDelta;
  session.totalStageCacheReadTokens += cacheReadTokensDelta;
  session.totalStageCacheWriteTokens += cacheWriteTokensDelta;
  session.lastReportedInputTokens = inputTokens;
  session.lastReportedOutputTokens = outputTokens;
  session.lastReportedTotalTokens = totalTokens;

  return {
    inputTokensDelta,
    outputTokensDelta,
    totalTokensDelta,
    cacheReadTokensDelta,
    cacheWriteTokensDelta,
    noCacheTokensDelta,
    reasoningTokensDelta,
    rateLimitsUpdated: event.rateLimits !== undefined,
  };
}

export function applyCodexEventToOrchestratorState(
  state: OrchestratorState,
  runningEntry: RunningEntry,
  event: CodexClientEvent,
): SessionTelemetryUpdateResult {
  const result = applyCodexEventToSession(runningEntry, event);

  state.codexTotals.inputTokens += result.inputTokensDelta;
  state.codexTotals.outputTokens += result.outputTokensDelta;
  state.codexTotals.totalTokens += result.totalTokensDelta;
  state.codexTotals.cacheReadTokens += result.cacheReadTokensDelta;
  state.codexTotals.cacheWriteTokens += result.cacheWriteTokensDelta;
  state.codexTotals.noCacheTokens += result.noCacheTokensDelta;
  state.codexTotals.reasoningTokens += result.reasoningTokensDelta;

  if (event.rateLimits !== undefined) {
    state.codexRateLimits = event.rateLimits;
  }

  return result;
}

export function addEndedSessionRuntime(
  state: OrchestratorState,
  startedAt: string,
  endedAt = new Date(),
): number {
  const startedAtMs = Date.parse(startedAt);
  const endedAtMs = endedAt.getTime();
  if (!Number.isFinite(startedAtMs) || endedAtMs < startedAtMs) {
    return state.codexTotals.secondsRunning;
  }

  const seconds = roundSeconds((endedAtMs - startedAtMs) / 1000);
  state.codexTotals.secondsRunning = roundSeconds(
    state.codexTotals.secondsRunning + seconds,
  );
  return state.codexTotals.secondsRunning;
}

export function getAggregateSecondsRunning(
  state: OrchestratorState,
  now = new Date(),
): number {
  const nowMs = now.getTime();
  let total = state.codexTotals.secondsRunning;

  for (const runningEntry of Object.values(state.running)) {
    const startedAtMs = Date.parse(runningEntry.startedAt);
    if (!Number.isFinite(startedAtMs) || nowMs < startedAtMs) {
      continue;
    }

    total += (nowMs - startedAtMs) / 1000;
  }

  return roundSeconds(total);
}

export function summarizeCodexEvent(event: CodexClientEvent): string {
  if (event.message !== undefined && event.message.trim().length > 0) {
    return event.message.trim();
  }

  if (
    event.event === "unsupported_tool_call" &&
    event.toolName !== undefined &&
    event.toolName !== null &&
    event.toolName.trim().length > 0
  ) {
    return `unsupported tool call: ${event.toolName.trim()}`;
  }

  const fallback = SESSION_EVENT_MESSAGES[event.event];
  return fallback ?? event.event;
}

function computeCounterDelta(previous: number, next: number): number {
  if (!Number.isFinite(previous)) {
    return next;
  }
  return Math.max(0, next - previous);
}

function normalizeAbsoluteCounter(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    return 0;
  }
  return Math.floor(value);
}

function roundSeconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}
