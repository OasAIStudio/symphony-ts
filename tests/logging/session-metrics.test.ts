import { describe, expect, it } from "vitest";

import type { CodexClientEvent } from "../../src/codex/app-server-client.js";
import {
  type RunningEntry,
  createEmptyLiveSession,
  createInitialOrchestratorState,
} from "../../src/domain/model.js";
import {
  addEndedSessionRuntime,
  applyCodexEventToOrchestratorState,
  getAggregateSecondsRunning,
  summarizeCodexEvent,
} from "../../src/logging/session-metrics.js";

describe("session metrics", () => {
  it("aggregates absolute usage totals without double-counting repeated updates", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 3,
    });
    const running = createRunningEntry();

    const started = createEvent("session_started", {
      sessionId: "thread-1-turn-1",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    const firstUsage = createEvent("notification", {
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
      },
      rateLimits: {
        requestsRemaining: 8,
      },
    });
    const repeatedUsage = createEvent("notification", {
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
      },
    });
    const secondUsage = createEvent("turn_completed", {
      usage: {
        inputTokens: 14,
        outputTokens: 9,
        totalTokens: 23,
      },
    });

    applyCodexEventToOrchestratorState(state, running, started);
    applyCodexEventToOrchestratorState(state, running, firstUsage);
    applyCodexEventToOrchestratorState(state, running, repeatedUsage);
    applyCodexEventToOrchestratorState(state, running, secondUsage);

    expect(running.turnCount).toBe(1);
    expect(running.codexInputTokens).toBe(14);
    expect(running.codexOutputTokens).toBe(9);
    expect(running.codexTotalTokens).toBe(23);
    expect(state.codexTotals).toEqual({
      inputTokens: 14,
      outputTokens: 9,
      totalTokens: 23,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      noCacheTokens: 0,
      reasoningTokens: 0,
      secondsRunning: 0,
    });
    expect(state.codexRateLimits).toEqual({
      requestsRemaining: 8,
    });
  });

  it("tracks ended runtime and recomputes live aggregate snapshot time", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 3,
    });
    const running = createRunningEntry();
    state.running[running.issue.id] = running;

    addEndedSessionRuntime(
      state,
      "2026-03-06T10:00:00.000Z",
      new Date("2026-03-06T10:00:05.250Z"),
    );

    const secondsRunning = getAggregateSecondsRunning(
      state,
      new Date("2026-03-06T10:00:10.500Z"),
    );

    expect(state.codexTotals.secondsRunning).toBe(5.25);
    expect(secondsRunning).toBe(15.75);
  });

  it("accumulates cache and reasoning token details when present", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 3,
    });
    const running = createRunningEntry();

    const eventWithDetails = createEvent("turn_completed", {
      usage: {
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
        cacheReadTokens: 5,
        cacheWriteTokens: 3,
        noCacheTokens: 12,
        reasoningTokens: 4,
      },
    });

    applyCodexEventToOrchestratorState(state, running, eventWithDetails);

    expect(running.codexCacheReadTokens).toBe(5);
    expect(running.codexCacheWriteTokens).toBe(3);
    expect(running.codexNoCacheTokens).toBe(12);
    expect(running.codexReasoningTokens).toBe(4);
    expect(state.codexTotals.cacheReadTokens).toBe(5);
    expect(state.codexTotals.cacheWriteTokens).toBe(3);
    expect(state.codexTotals.noCacheTokens).toBe(12);
    expect(state.codexTotals.reasoningTokens).toBe(4);
  });

  it("leaves detail token counts at 0 when usage has no detail fields", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 3,
    });
    const running = createRunningEntry();

    const eventWithoutDetails = createEvent("turn_completed", {
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
      },
    });

    applyCodexEventToOrchestratorState(state, running, eventWithoutDetails);

    expect(running.codexCacheReadTokens).toBe(0);
    expect(running.codexCacheWriteTokens).toBe(0);
    expect(running.codexNoCacheTokens).toBe(0);
    expect(running.codexReasoningTokens).toBe(0);
    expect(state.codexTotals.cacheReadTokens).toBe(0);
    expect(state.codexTotals.cacheWriteTokens).toBe(0);
    expect(state.codexTotals.noCacheTokens).toBe(0);
    expect(state.codexTotals.reasoningTokens).toBe(0);
  });

  it("accumulates detail tokens across multiple events", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 3,
    });
    const running = createRunningEntry();

    const firstEvent = createEvent("notification", {
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        cacheReadTokens: 3,
        reasoningTokens: 2,
      },
    });
    const secondEvent = createEvent("turn_completed", {
      usage: {
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
        cacheReadTokens: 7,
        reasoningTokens: 6,
      },
    });

    applyCodexEventToOrchestratorState(state, running, firstEvent);
    applyCodexEventToOrchestratorState(state, running, secondEvent);

    // Detail tokens are accumulated additively (not absolute like input/output/total)
    expect(running.codexCacheReadTokens).toBe(10);
    expect(running.codexReasoningTokens).toBe(8);
    expect(state.codexTotals.cacheReadTokens).toBe(10);
    expect(state.codexTotals.reasoningTokens).toBe(8);
  });

  it("returns zero deltas for detail tokens when no usage on event", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 3,
    });
    const running = createRunningEntry();

    const noUsageEvent = createEvent("notification");
    const result = applyCodexEventToOrchestratorState(state, running, noUsageEvent);

    expect(result.cacheReadTokensDelta).toBe(0);
    expect(result.cacheWriteTokensDelta).toBe(0);
    expect(result.noCacheTokensDelta).toBe(0);
    expect(result.reasoningTokensDelta).toBe(0);
  });

  it("accumulates codexTotalInputTokens and codexTotalOutputTokens across multiple turns", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 3,
    });
    const running = createRunningEntry();

    // Turn 1 starts: session_started resets lastReported counters to 0
    const turn1Start = createEvent("session_started", {
      sessionId: "thread-1-turn-1",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    applyCodexEventToOrchestratorState(state, running, turn1Start);

    // Turn 1 completes: 100 input, 40 output
    const turn1End = createEvent("turn_completed", {
      usage: {
        inputTokens: 100,
        outputTokens: 40,
        totalTokens: 140,
      },
    });
    applyCodexEventToOrchestratorState(state, running, turn1End);

    expect(running.codexTotalInputTokens).toBe(100);
    expect(running.codexTotalOutputTokens).toBe(40);

    // Turn 2 starts: session_started resets lastReported counters to 0
    const turn2Start = createEvent("session_started", {
      sessionId: "thread-1-turn-2",
      threadId: "thread-1",
      turnId: "turn-2",
    });
    applyCodexEventToOrchestratorState(state, running, turn2Start);

    // Turn 2 completes: 120 input, 60 output (counter resets to 0 each turn)
    const turn2End = createEvent("turn_completed", {
      usage: {
        inputTokens: 120,
        outputTokens: 60,
        totalTokens: 180,
      },
    });
    applyCodexEventToOrchestratorState(state, running, turn2End);

    // codexTotalInputTokens/OutputTokens should sum both turns: 100+120=220, 40+60=100
    expect(running.codexTotalInputTokens).toBe(220);
    expect(running.codexTotalOutputTokens).toBe(100);

    // codexInputTokens still reflects the last absolute value (current turn only)
    expect(running.codexInputTokens).toBe(120);
    expect(running.codexOutputTokens).toBe(60);
  });

  it("summarizes codex events for snapshot and log surfaces", () => {
    expect(
      summarizeCodexEvent(
        createEvent("unsupported_tool_call", {
          toolName: "linear_graphql",
        }),
      ),
    ).toBe("unsupported tool call: linear_graphql");
    expect(
      summarizeCodexEvent(
        createEvent("other_message", {
          message: "diagnostic from stderr",
        }),
      ),
    ).toBe("diagnostic from stderr");
  });
});

function createRunningEntry(): RunningEntry {
  return {
    ...createEmptyLiveSession(),
    issue: {
      id: "issue-1",
      identifier: "ABC-123",
      title: "Example",
      description: null,
      priority: 1,
      state: "In Progress",
      branchName: null,
      url: null,
      labels: [],
      blockedBy: [],
      createdAt: null,
      updatedAt: null,
    },
    identifier: "ABC-123",
    retryAttempt: null,
    startedAt: "2026-03-06T10:00:00.000Z",
    workerHandle: null,
    monitorHandle: null,
  };
}

function createEvent(
  event: CodexClientEvent["event"],
  overrides?: Partial<CodexClientEvent>,
): CodexClientEvent {
  return {
    event,
    timestamp: "2026-03-06T10:00:01.000Z",
    codexAppServerPid: "42",
    ...overrides,
  };
}
