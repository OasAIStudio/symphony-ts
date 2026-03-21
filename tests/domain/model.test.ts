import { describe, expect, it } from "vitest";

import {
  FAILURE_CLASSES,
  ORCHESTRATOR_EVENTS,
  ORCHESTRATOR_ISSUE_STATUSES,
  RUN_ATTEMPT_PHASES,
  createEmptyLiveSession,
  createInitialOrchestratorState,
  normalizeIssueState,
  parseFailureSignal,
  toSessionId,
  toWorkspaceKey,
} from "../../src/domain/model.js";

describe("domain model", () => {
  it("tracks the orchestrator issue lifecycle states from the spec", () => {
    expect(ORCHESTRATOR_ISSUE_STATUSES).toEqual([
      "unclaimed",
      "claimed",
      "running",
      "retry_queued",
      "released",
    ]);
  });

  it("tracks the run attempt phases and orchestrator events required by the spec", () => {
    expect(RUN_ATTEMPT_PHASES).toEqual([
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
    ]);
    expect(ORCHESTRATOR_EVENTS).toEqual([
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
    ]);
  });

  it("normalizes state, workspace, and session identifiers deterministically", () => {
    expect(normalizeIssueState(" In Progress ")).toBe("in progress");
    expect(toWorkspaceKey("ABC-123/needs review")).toBe("ABC-123_needs_review");
    expect(toSessionId("thread-1", "turn-2")).toBe("thread-1-turn-2");
  });

  it("creates empty live session and orchestrator state baselines", () => {
    expect(createEmptyLiveSession()).toEqual({
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
    });

    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 10,
    });

    expect(state.pollIntervalMs).toBe(30_000);
    expect(state.maxConcurrentAgents).toBe(10);
    expect(state.running).toEqual({});
    expect([...state.claimed]).toEqual([]);
    expect(state.retryAttempts).toEqual({});
    expect([...state.completed]).toEqual([]);
    expect(state.codexTotals).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      noCacheTokens: 0,
      reasoningTokens: 0,
      secondsRunning: 0,
    });
    expect(state.codexRateLimits).toBeNull();
  });
});

describe("parseFailureSignal", () => {
  it("defines the expected failure classes", () => {
    expect(FAILURE_CLASSES).toEqual(["verify", "review", "spec", "infra"]);
  });

  it("parses each failure class from agent output", () => {
    expect(parseFailureSignal("[STAGE_FAILED: verify]")).toEqual({ failureClass: "verify" });
    expect(parseFailureSignal("[STAGE_FAILED: review]")).toEqual({ failureClass: "review" });
    expect(parseFailureSignal("[STAGE_FAILED: spec]")).toEqual({ failureClass: "spec" });
    expect(parseFailureSignal("[STAGE_FAILED: infra]")).toEqual({ failureClass: "infra" });
  });

  it("returns null for null, undefined, or empty input", () => {
    expect(parseFailureSignal(null)).toBeNull();
    expect(parseFailureSignal(undefined)).toBeNull();
    expect(parseFailureSignal("")).toBeNull();
  });

  it("returns null when no failure signal is present", () => {
    expect(parseFailureSignal("[STAGE_COMPLETE]")).toBeNull();
    expect(parseFailureSignal("All tests passed successfully.")).toBeNull();
    expect(parseFailureSignal("STAGE_FAILED: verify")).toBeNull();
  });

  it("extracts signal from longer agent output", () => {
    const output = "Tests failed.\n[STAGE_FAILED: verify]\nSee logs for details.";
    expect(parseFailureSignal(output)).toEqual({ failureClass: "verify" });
  });

  it("handles extra whitespace inside brackets", () => {
    expect(parseFailureSignal("[STAGE_FAILED:  spec ]")).toEqual({ failureClass: "spec" });
    expect(parseFailureSignal("[STAGE_FAILED:review]")).toEqual({ failureClass: "review" });
  });

  it("rejects unknown failure classes", () => {
    expect(parseFailureSignal("[STAGE_FAILED: unknown]")).toBeNull();
    expect(parseFailureSignal("[STAGE_FAILED: timeout]")).toBeNull();
  });
});
