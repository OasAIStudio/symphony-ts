import * as path from "node:path";
import type { CodexClientEvent } from "../codex/app-server-client.js";
import type {
  LiveSession,
  OrchestratorState,
  RecentActivityEntry,
  RunningEntry,
  TurnHistoryEntry,
} from "../domain/model.js";

const TURN_HISTORY_MAX_SIZE = 50;
const RECENT_ACTIVITY_MAX_SIZE = 10;

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
    // Push previous turn summary to ring buffer before resetting counters
    if (session.turnCount > 0) {
      const entry: TurnHistoryEntry = {
        turnNumber: session.turnCount,
        timestamp: event.timestamp,
        message: session.lastCodexMessage,
        inputTokens: session.codexInputTokens,
        outputTokens: session.codexOutputTokens,
        totalTokens: session.codexTotalTokens,
        cacheReadTokens: session.codexCacheReadTokens,
        reasoningTokens: session.codexReasoningTokens,
        event: session.lastCodexEvent,
      };
      session.turnHistory.push(entry);
      if (session.turnHistory.length > TURN_HISTORY_MAX_SIZE) {
        session.turnHistory.splice(
          0,
          session.turnHistory.length - TURN_HISTORY_MAX_SIZE,
        );
      }
    }
    session.turnCount += 1;
    // Reset per-turn absolute counters so the next turn's deltas accumulate from 0
    session.lastReportedInputTokens = 0;
    session.lastReportedOutputTokens = 0;
    session.lastReportedTotalTokens = 0;
  }

  const activityEntry = buildRecentActivityEntry(event);
  if (activityEntry !== null) {
    session.recentActivity.push(activityEntry);
    if (session.recentActivity.length > RECENT_ACTIVITY_MAX_SIZE) {
      session.recentActivity.splice(
        0,
        session.recentActivity.length - RECENT_ACTIVITY_MAX_SIZE,
      );
    }
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

/**
 * Extract the tool name from a raw JSON-RPC message object.
 * Duplicates the extraction logic from app-server-client.ts (which is private).
 */
function extractNestedString(
  source: Record<string, unknown>,
  keyPath: readonly string[],
): string | null {
  let current: unknown = source;
  for (const segment of keyPath) {
    if (
      current === null ||
      typeof current !== "object" ||
      Array.isArray(current)
    ) {
      return null;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (typeof current === "string" && current.trim().length > 0) {
    return current.trim();
  }
  return null;
}

export function extractToolNameFromRaw(
  raw: Record<string, unknown>,
): string | null {
  const candidates = [
    extractNestedString(raw, ["params", "toolName"]),
    extractNestedString(raw, ["params", "name"]),
    extractNestedString(raw, ["params", "tool", "name"]),
    extractNestedString(raw, ["name"]),
  ];
  return candidates.find((v) => v !== null) ?? null;
}

export function extractToolInputFromRaw(raw: Record<string, unknown>): unknown {
  const params =
    raw.params !== null &&
    typeof raw.params === "object" &&
    !Array.isArray(raw.params)
      ? (raw.params as Record<string, unknown>)
      : null;

  if (params === null) {
    return undefined;
  }

  const candidates = [
    params.input,
    params.arguments,
    params.args,
    params.payload,
    params.toolInput,
  ];

  for (const candidate of candidates) {
    if (candidate !== undefined) {
      return candidate;
    }
  }

  return undefined;
}

const NOTIFICATION_CONTEXT_MAX_LENGTH = 80;
const BASH_COMMAND_MAX_LENGTH = 60;

/**
 * Build a RecentActivityEntry from a CodexClientEvent, or return null if the
 * event type should not produce an activity entry.
 */
function buildRecentActivityEntry(
  event: CodexClientEvent,
): RecentActivityEntry | null {
  // Tool-call events: extract tool name + context from raw payload
  if (
    (event.event === "approval_auto_approved" ||
      event.event === "unsupported_tool_call") &&
    event.raw != null
  ) {
    const raw =
      typeof event.raw === "object" && !Array.isArray(event.raw)
        ? (event.raw as Record<string, unknown>)
        : null;
    if (raw !== null) {
      const toolName = extractToolNameFromRaw(raw);
      if (toolName !== null) {
        const toolInput = extractToolInputFromRaw(raw);
        const context = buildActivityContext(toolName, toolInput);
        const entry: RecentActivityEntry = {
          timestamp: event.timestamp,
          toolName,
          context,
        };
        if (event.usage !== undefined) {
          const total = normalizeAbsoluteCounter(event.usage.totalTokens);
          if (total > 0) {
            entry.totalTokens = total;
          }
        }
        return entry;
      }
    }
    return null;
  }

  // Turn outcome events: show turn result with optional token count
  if (event.event === "turn_completed" || event.event === "turn_failed") {
    const label =
      event.event === "turn_completed" ? "Turn completed" : "Turn failed";
    const entry: RecentActivityEntry = {
      timestamp: event.timestamp,
      toolName: label,
      context: null,
    };
    if (event.usage !== undefined) {
      const total = normalizeAbsoluteCounter(event.usage.totalTokens);
      if (total > 0) {
        entry.totalTokens = total;
      }
    }
    return entry;
  }

  // Session started
  if (event.event === "session_started") {
    return {
      timestamp: event.timestamp,
      toolName: "Session started",
      context: null,
    };
  }

  // Notification: use event.message (truncated) as context
  if (event.event === "notification") {
    let context: string | null = null;
    if (event.message !== undefined && event.message.trim().length > 0) {
      const trimmed = event.message.trim();
      if (trimmed.length <= NOTIFICATION_CONTEXT_MAX_LENGTH) {
        context = trimmed;
      } else {
        context = `${trimmed.slice(0, NOTIFICATION_CONTEXT_MAX_LENGTH)}…`;
      }
    }
    return { timestamp: event.timestamp, toolName: "Notification", context };
  }

  return null;
}

/**
 * Add a pipeline-level (non-CC) activity entry to a session's recentActivity.
 * Used by the orchestrator to record stage transitions, state changes, and
 * session start events so the activity feed is never empty.
 */
export function addPipelineActivity(
  session: LiveSession,
  eventType: string,
  description: string,
): void {
  const entry: RecentActivityEntry = {
    timestamp: new Date().toISOString(),
    toolName: eventType,
    context: description,
  };
  session.recentActivity.push(entry);
  if (session.recentActivity.length > RECENT_ACTIVITY_MAX_SIZE) {
    session.recentActivity.splice(
      0,
      session.recentActivity.length - RECENT_ACTIVITY_MAX_SIZE,
    );
  }
}

export function buildActivityContext(
  toolName: string,
  toolInput: unknown,
): string | null {
  if (
    toolInput === null ||
    toolInput === undefined ||
    typeof toolInput !== "object" ||
    Array.isArray(toolInput)
  ) {
    return null;
  }

  const input = toolInput as Record<string, unknown>;
  const normalized = toolName.toLowerCase();

  // File tools: Read, Edit, Write, Glob — extract file_path or pattern, take basename
  if (
    normalized === "read" ||
    normalized === "edit" ||
    normalized === "write"
  ) {
    const filePath =
      typeof input.file_path === "string" ? input.file_path : null;
    if (filePath !== null && filePath.trim().length > 0) {
      return path.basename(filePath.trim());
    }
    return null;
  }

  if (normalized === "glob") {
    const pattern = typeof input.pattern === "string" ? input.pattern : null;
    if (pattern !== null && pattern.trim().length > 0) {
      return pattern.trim();
    }
    return null;
  }

  // Bash: extract command and truncate
  if (normalized === "bash") {
    const command = typeof input.command === "string" ? input.command : null;
    if (command !== null && command.trim().length > 0) {
      const trimmed = command.trim();
      if (trimmed.length <= BASH_COMMAND_MAX_LENGTH) {
        return trimmed;
      }
      return `${trimmed.slice(0, BASH_COMMAND_MAX_LENGTH)}…`;
    }
    return null;
  }

  // Grep: extract pattern
  if (normalized === "grep") {
    const pattern = typeof input.pattern === "string" ? input.pattern : null;
    if (pattern !== null && pattern.trim().length > 0) {
      return pattern.trim();
    }
    return null;
  }

  return null;
}
