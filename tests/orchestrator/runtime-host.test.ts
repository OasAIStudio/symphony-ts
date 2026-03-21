import { describe, expect, it, vi } from "vitest";

import type {
  AgentRunResult,
  AgentRunnerEvent,
} from "../../src/agent/runner.js";
import type { ResolvedWorkflowConfig } from "../../src/config/types.js";
import type { Issue } from "../../src/domain/model.js";
import {
  type StructuredLogEntry,
  StructuredLogger,
} from "../../src/logging/structured-logger.js";
import {
  OrchestratorRuntimeHost,
  startRuntimeService,
} from "../../src/orchestrator/runtime-host.js";
import type {
  IssueStateSnapshot,
  IssueTracker,
} from "../../src/tracker/tracker.js";

describe("OrchestratorRuntimeHost", () => {
  it("feeds codex events into orchestrator state and schedules continuation retry after a normal worker exit", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    const tick = await host.pollOnce();

    expect(tick.dispatchedIssueIds).toEqual(["1"]);
    fakeRunner.emit("1", {
      event: "session_started",
      timestamp: "2026-03-06T00:00:01.000Z",
      codexAppServerPid: "1001",
      sessionId: "thread-1-turn-1",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    fakeRunner.emit("1", {
      event: "turn_completed",
      timestamp: "2026-03-06T00:00:02.000Z",
      codexAppServerPid: "1001",
      sessionId: "thread-1-turn-1",
      threadId: "thread-1",
      turnId: "turn-1",
      usage: {
        inputTokens: 11,
        outputTokens: 7,
        totalTokens: 18,
      },
      rateLimits: {
        requestsRemaining: 9,
      },
      message: "turn completed",
    });
    await host.flushEvents();

    let snapshot = await host.getRuntimeSnapshot();
    expect(snapshot.running).toEqual([
      expect.objectContaining({
        issue_id: "1",
        session_id: "thread-1-turn-1",
        turn_count: 1,
        last_event: "turn_completed",
        last_message: "turn completed",
        tokens: {
          input_tokens: 11,
          output_tokens: 7,
          total_tokens: 18,
        },
      }),
    ]);
    expect(snapshot.codex_totals.total_tokens).toBe(18);

    fakeRunner.resolve("1", {
      issue: createIssue({ state: "In Progress" }),
      workspace: {
        path: "/tmp/workspaces/1",
        workspaceKey: "1",
        createdNow: true,
      },
      runAttempt: {
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        attempt: null,
        workspacePath: "/tmp/workspaces/1",
        startedAt: "2026-03-06T00:00:00.000Z",
        status: "succeeded",
      },
      liveSession: {
        sessionId: "thread-1-turn-1",
        threadId: "thread-1",
        turnId: "turn-1",
        codexAppServerPid: "1001",
        lastCodexEvent: "turn_completed",
        lastCodexTimestamp: "2026-03-06T00:00:02.000Z",
        lastCodexMessage: "turn completed",
        codexInputTokens: 11,
        codexOutputTokens: 7,
        codexTotalTokens: 18,
        codexCacheReadTokens: 0,
        codexCacheWriteTokens: 0,
        codexNoCacheTokens: 0,
        codexReasoningTokens: 0,
        codexTotalInputTokens: 11,
        codexTotalOutputTokens: 7,
        lastReportedInputTokens: 11,
        lastReportedOutputTokens: 7,
        lastReportedTotalTokens: 18,
        turnCount: 1,
        totalStageInputTokens: 0,
        totalStageOutputTokens: 0,
        totalStageTotalTokens: 0,
        totalStageCacheReadTokens: 0,
        totalStageCacheWriteTokens: 0,
      },
      turnsCompleted: 1,
      lastTurn: null,
      rateLimits: {
        requestsRemaining: 9,
      },
    });
    await host.waitForIdle();

    snapshot = await host.getRuntimeSnapshot();
    expect(snapshot.running).toEqual([]);
    expect(snapshot.retrying).toEqual([
      expect.objectContaining({
        issue_id: "1",
        issue_identifier: "ISSUE-1",
        attempt: 1,
        error: null,
      }),
    ]);
  });

  it("cancels a reconciled worker and releases the claim when the issue is no longer eligible on retry", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    tracker.setStateSnapshots([
      { id: "1", identifier: "ISSUE-1", state: "Done" },
    ]);

    const reconcileTick = await host.pollOnce();
    expect(reconcileTick.stopRequests).toEqual([
      {
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        cleanupWorkspace: true,
        reason: "terminal_state",
      },
    ]);
    await host.waitForIdle();

    expect(fakeRunner.abortReasons).toEqual(["Stopped due to terminal_state."]);
    expect(Object.keys(host.getState().retryAttempts)).toEqual(["1"]);

    tracker.setCandidates([]);
    const retryResult = await host.runRetryTimer("1");

    expect(retryResult).toEqual({
      dispatched: false,
      released: true,
      retryEntry: null,
    });
    expect([...host.getState().claimed]).toEqual([]);
  });

  it("coalesces manual refresh requests onto a single queued poll", async () => {
    const tracker = createTracker({
      candidates: [],
    });
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      agentRunner: new FakeAgentRunner(),
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    const [first, second] = await Promise.all([
      host.requestRefresh(),
      host.requestRefresh(),
    ]);
    await host.waitForIdle();

    expect(first).toMatchObject({
      queued: true,
      coalesced: false,
      operations: ["poll", "reconcile"],
    });
    expect(second).toMatchObject({
      queued: true,
      coalesced: true,
    });
    expect(tracker.fetchCandidateIssues).toHaveBeenCalledTimes(1);
  });

  it("resolves running workspace details from issue id after identifier changes", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    tracker.setStateSnapshots([
      { id: "1", identifier: "RENAMED-2", state: "In Progress" },
    ]);
    await host.pollOnce();

    const details = await host.getIssueDetails("RENAMED-2");

    expect(details).toMatchObject({
      issue_identifier: "RENAMED-2",
      workspace: {
        path: "/tmp/workspaces/1",
      },
    });
  });

  it("emits issue and session context for agent lifecycle logs", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const entries: StructuredLogEntry[] = [];
    const logger = new StructuredLogger([
      {
        write(entry) {
          entries.push(entry);
        },
      },
    ]);
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      logger,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    fakeRunner.emit("1", {
      event: "session_started",
      timestamp: "2026-03-06T00:00:01.000Z",
      codexAppServerPid: "1001",
      sessionId: "thread-1-turn-1",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    await host.flushEvents();

    expect(entries).toContainEqual(
      expect.objectContaining({
        event: "worker_spawned",
        issue_id: "1",
        issue_identifier: "ISSUE-1",
      }),
    );
    expect(entries).toContainEqual(
      expect.objectContaining({
        event: "session_started",
        issue_id: "1",
        issue_identifier: "ISSUE-1",
        session_id: "thread-1-turn-1",
      }),
    );
  });

  it("logs turn_number, prompt_chars, and estimated_prompt_tokens for turn_completed events", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const entries: StructuredLogEntry[] = [];
    const logger = new StructuredLogger([
      {
        write(entry) {
          entries.push(entry);
        },
      },
    ]);
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      logger,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    fakeRunner.emit("1", {
      event: "turn_completed",
      timestamp: "2026-03-06T00:00:02.000Z",
      codexAppServerPid: "1001",
      sessionId: "thread-1-turn-1",
      threadId: "thread-1",
      turnId: "turn-1",
      turnCount: 1,
      promptChars: 1200,
      estimatedPromptTokens: 300,
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
      },
      message: "turn done",
    });
    await host.flushEvents();

    const turnCompletedEntry = entries.find(
      (e) => e.event === "turn_completed",
    );
    expect(turnCompletedEntry).toBeDefined();
    expect(turnCompletedEntry).toMatchObject({
      event: "turn_completed",
      turn_number: 1,
      prompt_chars: 1200,
      estimated_prompt_tokens: 300,
    });
  });

  it("emits stage_completed event on normal worker exit with token and turn fields", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const entries: StructuredLogEntry[] = [];
    const logger = new StructuredLogger([
      {
        write(entry) {
          entries.push(entry);
        },
      },
    ]);
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      logger,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    fakeRunner.resolve("1", {
      issue: createIssue({ state: "In Progress" }),
      workspace: {
        path: "/tmp/workspaces/1",
        workspaceKey: "1",
        createdNow: true,
      },
      runAttempt: {
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        attempt: null,
        workspacePath: "/tmp/workspaces/1",
        startedAt: "2026-03-06T00:00:00.000Z",
        status: "succeeded",
      },
      liveSession: {
        sessionId: "thread-1-turn-1",
        threadId: "thread-1",
        turnId: "turn-1",
        codexAppServerPid: "1001",
        lastCodexEvent: "turn_completed",
        lastCodexTimestamp: "2026-03-06T00:00:02.000Z",
        lastCodexMessage: "done",
        codexInputTokens: 100,
        codexOutputTokens: 50,
        codexTotalTokens: 150,
        codexCacheReadTokens: 10,
        codexCacheWriteTokens: 5,
        codexNoCacheTokens: 0,
        codexReasoningTokens: 20,
        codexTotalInputTokens: 280,
        codexTotalOutputTokens: 140,
        lastReportedInputTokens: 100,
        lastReportedOutputTokens: 50,
        lastReportedTotalTokens: 150,
        turnCount: 3,
        totalStageInputTokens: 300,
        totalStageOutputTokens: 150,
        totalStageTotalTokens: 450,
        totalStageCacheReadTokens: 30,
        totalStageCacheWriteTokens: 15,
      },
      turnsCompleted: 3,
      lastTurn: null,
      rateLimits: null,
    });
    await host.waitForIdle();

    const stageCompletedEntry = entries.find(
      (e) => e.event === "stage_completed",
    );
    expect(stageCompletedEntry).toBeDefined();
    expect(stageCompletedEntry).toMatchObject({
      event: "stage_completed",
      level: "info",
      issue_id: "1",
      issue_identifier: "ISSUE-1",
      session_id: "thread-1-turn-1",
      stage_name: null,
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      cache_read_tokens: 10,
      cache_write_tokens: 5,
      reasoning_tokens: 20,
      turns_used: 3,
      total_input_tokens: 300,
      total_output_tokens: 150,
      total_total_tokens: 450,
      total_cache_read_tokens: 30,
      total_cache_write_tokens: 15,
      turn_count: 3,
      duration_ms: 5000,
      outcome: "completed",
    });
  });

  it("emits stage_completed event on abnormal worker exit with outcome failed", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const entries: StructuredLogEntry[] = [];
    const logger = new StructuredLogger([
      {
        write(entry) {
          entries.push(entry);
        },
      },
    ]);
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      logger,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    fakeRunner.reject("1", new Error("something went wrong"));
    await host.waitForIdle();

    const stageCompletedEntry = entries.find(
      (e) => e.event === "stage_completed",
    );
    expect(stageCompletedEntry).toBeDefined();
    expect(stageCompletedEntry).toMatchObject({
      event: "stage_completed",
      level: "info",
      issue_id: "1",
      issue_identifier: "ISSUE-1",
      stage_name: null,
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      turns_used: 0,
      total_input_tokens: 0,
      total_output_tokens: 0,
      total_total_tokens: 0,
      turn_count: 0,
      duration_ms: 0,
      outcome: "failed",
    });
  });

  it("emits stage_completed with correct stage_name when stages are configured", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const entries: StructuredLogEntry[] = [];
    const logger = new StructuredLogger([
      {
        write(entry) {
          entries.push(entry);
        },
      },
    ]);
    const host = new OrchestratorRuntimeHost({
      config: createStagedConfig(),
      tracker,
      logger,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    fakeRunner.resolve("1", {
      issue: createIssue({ state: "In Progress" }),
      workspace: {
        path: "/tmp/workspaces/1",
        workspaceKey: "1",
        createdNow: true,
      },
      runAttempt: {
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        attempt: null,
        workspacePath: "/tmp/workspaces/1",
        startedAt: "2026-03-06T00:00:00.000Z",
        status: "succeeded",
      },
      liveSession: {
        sessionId: "thread-1-turn-1",
        threadId: "thread-1",
        turnId: "turn-1",
        codexAppServerPid: "1001",
        lastCodexEvent: "turn_completed",
        lastCodexTimestamp: "2026-03-06T00:00:02.000Z",
        lastCodexMessage: "done",
        codexInputTokens: 30,
        codexOutputTokens: 20,
        codexTotalTokens: 50,
        codexCacheReadTokens: 0,
        codexCacheWriteTokens: 0,
        codexNoCacheTokens: 0,
        codexReasoningTokens: 0,
        codexTotalInputTokens: 60,
        codexTotalOutputTokens: 40,
        lastReportedInputTokens: 30,
        lastReportedOutputTokens: 20,
        lastReportedTotalTokens: 50,
        turnCount: 2,
        totalStageInputTokens: 0,
        totalStageOutputTokens: 0,
        totalStageTotalTokens: 0,
        totalStageCacheReadTokens: 0,
        totalStageCacheWriteTokens: 0,
      },
      turnsCompleted: 2,
      lastTurn: null,
      rateLimits: null,
    });
    await host.waitForIdle();

    const stageCompletedEntry = entries.find(
      (e) => e.event === "stage_completed",
    );
    expect(stageCompletedEntry).toBeDefined();
    expect(stageCompletedEntry).toMatchObject({
      event: "stage_completed",
      stage_name: "investigate",
      turns_used: 2,
      turn_count: 2,
    });
  });

  it("includes no_cache_tokens in stage_completed when codexNoCacheTokens is non-zero", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const entries: StructuredLogEntry[] = [];
    const logger = new StructuredLogger([
      {
        write(entry) {
          entries.push(entry);
        },
      },
    ]);
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      logger,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    fakeRunner.resolve("1", {
      issue: createIssue({ state: "In Progress" }),
      workspace: {
        path: "/tmp/workspaces/1",
        workspaceKey: "1",
        createdNow: true,
      },
      runAttempt: {
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        attempt: null,
        workspacePath: "/tmp/workspaces/1",
        startedAt: "2026-03-06T00:00:00.000Z",
        status: "succeeded",
      },
      liveSession: {
        sessionId: "thread-1-turn-1",
        threadId: "thread-1",
        turnId: "turn-1",
        codexAppServerPid: "1001",
        lastCodexEvent: "turn_completed",
        lastCodexTimestamp: "2026-03-06T00:00:02.000Z",
        lastCodexMessage: "done",
        codexInputTokens: 100,
        codexOutputTokens: 50,
        codexTotalTokens: 150,
        codexCacheReadTokens: 0,
        codexCacheWriteTokens: 0,
        codexNoCacheTokens: 42,
        codexReasoningTokens: 0,
        codexTotalInputTokens: 100,
        codexTotalOutputTokens: 50,
        lastReportedInputTokens: 100,
        lastReportedOutputTokens: 50,
        lastReportedTotalTokens: 150,
        turnCount: 1,
        totalStageInputTokens: 0,
        totalStageOutputTokens: 0,
        totalStageTotalTokens: 0,
        totalStageCacheReadTokens: 0,
        totalStageCacheWriteTokens: 0,
      },
      turnsCompleted: 1,
      lastTurn: null,
      rateLimits: null,
    });
    await host.waitForIdle();

    const stageCompletedEntry = entries.find(
      (e) => e.event === "stage_completed",
    );
    expect(stageCompletedEntry).toBeDefined();
    expect(stageCompletedEntry).toMatchObject({
      event: "stage_completed",
      no_cache_tokens: 42,
    });
  });

  it("omits no_cache_tokens from stage_completed when codexNoCacheTokens is zero", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const entries: StructuredLogEntry[] = [];
    const logger = new StructuredLogger([
      {
        write(entry) {
          entries.push(entry);
        },
      },
    ]);
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      logger,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();
    fakeRunner.resolve("1", {
      issue: createIssue({ state: "In Progress" }),
      workspace: {
        path: "/tmp/workspaces/1",
        workspaceKey: "1",
        createdNow: true,
      },
      runAttempt: {
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        attempt: null,
        workspacePath: "/tmp/workspaces/1",
        startedAt: "2026-03-06T00:00:00.000Z",
        status: "succeeded",
      },
      liveSession: {
        sessionId: "thread-1-turn-1",
        threadId: "thread-1",
        turnId: "turn-1",
        codexAppServerPid: "1001",
        lastCodexEvent: "turn_completed",
        lastCodexTimestamp: "2026-03-06T00:00:02.000Z",
        lastCodexMessage: "done",
        codexInputTokens: 100,
        codexOutputTokens: 50,
        codexTotalTokens: 150,
        codexCacheReadTokens: 0,
        codexCacheWriteTokens: 0,
        codexNoCacheTokens: 0,
        codexReasoningTokens: 0,
        codexTotalInputTokens: 100,
        codexTotalOutputTokens: 50,
        lastReportedInputTokens: 100,
        lastReportedOutputTokens: 50,
        lastReportedTotalTokens: 150,
        turnCount: 1,
        totalStageInputTokens: 0,
        totalStageOutputTokens: 0,
        totalStageTotalTokens: 0,
        totalStageCacheReadTokens: 0,
        totalStageCacheWriteTokens: 0,
      },
      turnsCompleted: 1,
      lastTurn: null,
      rateLimits: null,
    });
    await host.waitForIdle();

    const stageCompletedEntry = entries.find(
      (e) => e.event === "stage_completed",
    );
    expect(stageCompletedEntry).toBeDefined();
    expect(stageCompletedEntry).not.toHaveProperty("no_cache_tokens");
  });

  it("aggregates total_input_tokens and total_output_tokens across multiple turns in stage_completed", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const entries: StructuredLogEntry[] = [];
    const logger = new StructuredLogger([
      {
        write(entry) {
          entries.push(entry);
        },
      },
    ]);
    const host = new OrchestratorRuntimeHost({
      config: createConfig(),
      tracker,
      logger,
      createAgentRunner: ({ onEvent }) => {
        fakeRunner.onEvent = onEvent;
        return fakeRunner;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await host.pollOnce();

    // Turn 1: 100 input, 40 output
    fakeRunner.emit("1", {
      event: "session_started",
      timestamp: "2026-03-06T00:00:01.000Z",
      codexAppServerPid: "1001",
      sessionId: "thread-1-turn-1",
      threadId: "thread-1",
      turnId: "turn-1",
    });
    fakeRunner.emit("1", {
      event: "turn_completed",
      timestamp: "2026-03-06T00:00:02.000Z",
      codexAppServerPid: "1001",
      sessionId: "thread-1-turn-1",
      threadId: "thread-1",
      turnId: "turn-1",
      usage: {
        inputTokens: 100,
        outputTokens: 40,
        totalTokens: 140,
        cacheReadTokens: 5,
        cacheWriteTokens: 3,
      },
      message: "turn 1 done",
    });

    // Turn 2: 120 input, 60 output (absolute counters reset per turn)
    fakeRunner.emit("1", {
      event: "session_started",
      timestamp: "2026-03-06T00:00:03.000Z",
      codexAppServerPid: "1001",
      sessionId: "thread-1-turn-2",
      threadId: "thread-1",
      turnId: "turn-2",
    });
    fakeRunner.emit("1", {
      event: "turn_completed",
      timestamp: "2026-03-06T00:00:04.000Z",
      codexAppServerPid: "1001",
      sessionId: "thread-1-turn-2",
      threadId: "thread-1",
      turnId: "turn-2",
      usage: {
        inputTokens: 120,
        outputTokens: 60,
        totalTokens: 180,
        cacheReadTokens: 8,
        cacheWriteTokens: 4,
      },
      message: "turn 2 done",
    });
    await host.flushEvents();

    fakeRunner.resolve("1", {
      issue: createIssue({ state: "In Progress" }),
      workspace: {
        path: "/tmp/workspaces/1",
        workspaceKey: "1",
        createdNow: true,
      },
      runAttempt: {
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        attempt: null,
        workspacePath: "/tmp/workspaces/1",
        startedAt: "2026-03-06T00:00:00.000Z",
        status: "succeeded",
      },
      liveSession: {
        sessionId: "thread-1-turn-2",
        threadId: "thread-1",
        turnId: "turn-2",
        codexAppServerPid: "1001",
        lastCodexEvent: "turn_completed",
        lastCodexTimestamp: "2026-03-06T00:00:04.000Z",
        lastCodexMessage: "turn 2 done",
        codexInputTokens: 120,
        codexOutputTokens: 60,
        codexTotalTokens: 180,
        codexCacheReadTokens: 13,
        codexCacheWriteTokens: 7,
        codexNoCacheTokens: 0,
        codexReasoningTokens: 0,
        codexTotalInputTokens: 220,
        codexTotalOutputTokens: 100,
        lastReportedInputTokens: 120,
        lastReportedOutputTokens: 60,
        lastReportedTotalTokens: 180,
        turnCount: 4,
        totalStageInputTokens: 220,
        totalStageOutputTokens: 100,
        totalStageTotalTokens: 320,
        totalStageCacheReadTokens: 13,
        totalStageCacheWriteTokens: 7,
      },
      turnsCompleted: 4,
      lastTurn: null,
      rateLimits: null,
    });
    await host.waitForIdle();

    const stageCompletedEntry = entries.find(
      (e) => e.event === "stage_completed",
    );
    expect(stageCompletedEntry).toBeDefined();
    expect(stageCompletedEntry).toMatchObject({
      event: "stage_completed",
      total_input_tokens: 220,
      total_output_tokens: 100,
      total_total_tokens: 320,
      total_cache_read_tokens: 13,
      total_cache_write_tokens: 7,
      turn_count: 4,
    });
  });
});

describe("startRuntimeService shutdown", () => {
  it("aborts running workers before waiting for idle on shutdown", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const entries: StructuredLogEntry[] = [];
    const logger = new StructuredLogger([
      {
        write(entry) {
          entries.push(entry);
        },
      },
    ]);

    const service = await startRuntimeService({
      config: createConfig(),
      tracker,
      logger,
      workflowWatcher: null,
      runtimeHost: new OrchestratorRuntimeHost({
        config: createConfig(),
        tracker,
        logger,
        createAgentRunner: ({ onEvent }) => {
          fakeRunner.onEvent = onEvent;
          return fakeRunner;
        },
        now: () => new Date("2026-03-06T00:00:05.000Z"),
      }),
    });

    // Wait for the initial poll to dispatch the worker
    await service.runtimeHost.flushEvents();

    // Call shutdown — should abort all workers
    await service.shutdown();

    expect(fakeRunner.abortReasons).toContain(
      "Shutdown: aborting running workers.",
    );
  });

  it("proceeds with exit after shutdown timeout if waitForIdle hangs", async () => {
    const tracker = createTracker();
    const entries: StructuredLogEntry[] = [];
    const logger = new StructuredLogger([
      {
        write(entry) {
          entries.push(entry);
        },
      },
    ]);

    // A runner that never settles — ignores abort signals
    const hangingRunner = {
      run(_input: Parameters<FakeAgentRunner["run"]>[0]): Promise<never> {
        return new Promise(() => {
          /* never resolves */
        });
      },
    };

    const service = await startRuntimeService({
      config: createConfig(),
      tracker,
      logger,
      workflowWatcher: null,
      shutdownTimeoutMs: 50,
      runtimeHost: new OrchestratorRuntimeHost({
        config: createConfig(),
        tracker,
        logger,
        agentRunner: hangingRunner,
        now: () => new Date("2026-03-06T00:00:05.000Z"),
      }),
    });

    // Wait for the initial poll to dispatch the worker
    await service.runtimeHost.flushEvents();

    // Shutdown should complete within a reasonable time despite the hanging runner
    const shutdownStart = Date.now();
    await service.shutdown();
    const elapsed = Date.now() - shutdownStart;

    // Should have completed well within a second (timeout is 50ms)
    expect(elapsed).toBeLessThan(5_000);

    const timeoutEntry = entries.find(
      (e) => e.event === "shutdown_idle_timeout",
    );
    expect(timeoutEntry).toBeDefined();
  });

  it("logs shutdown_complete event with correct fields after clean shutdown", async () => {
    const tracker = createTracker();
    const fakeRunner = new FakeAgentRunner();
    const entries: StructuredLogEntry[] = [];
    const logger = new StructuredLogger([
      {
        write(entry) {
          entries.push(entry);
        },
      },
    ]);

    const service = await startRuntimeService({
      config: createConfig(),
      tracker,
      logger,
      workflowWatcher: null,
      runtimeHost: new OrchestratorRuntimeHost({
        config: createConfig(),
        tracker,
        logger,
        createAgentRunner: ({ onEvent }) => {
          fakeRunner.onEvent = onEvent;
          return fakeRunner;
        },
        now: () => new Date("2026-03-06T00:00:05.000Z"),
      }),
    });

    // Wait for initial poll to dispatch worker
    await service.runtimeHost.flushEvents();

    // Call shutdown
    await service.shutdown();

    const completeEntry = entries.find((e) => e.event === "shutdown_complete");
    expect(completeEntry).toBeDefined();
    expect(completeEntry).toHaveProperty("workers_aborted");
    expect(typeof completeEntry?.workers_aborted).toBe("number");
    expect(completeEntry).toHaveProperty("timed_out", false);
    expect(completeEntry).toHaveProperty("duration_ms");
    expect(typeof completeEntry?.duration_ms).toBe("number");
  });

  it("logs shutdown_complete with timed_out=true when shutdown timeout fires", async () => {
    const tracker = createTracker();
    const entries: StructuredLogEntry[] = [];
    const logger = new StructuredLogger([
      {
        write(entry) {
          entries.push(entry);
        },
      },
    ]);

    // A runner that never settles — ignores abort signals
    const hangingRunner = {
      run(_input: Parameters<FakeAgentRunner["run"]>[0]): Promise<never> {
        return new Promise(() => {
          /* never resolves */
        });
      },
    };

    const service = await startRuntimeService({
      config: createConfig(),
      tracker,
      logger,
      workflowWatcher: null,
      shutdownTimeoutMs: 50,
      runtimeHost: new OrchestratorRuntimeHost({
        config: createConfig(),
        tracker,
        logger,
        agentRunner: hangingRunner,
        now: () => new Date("2026-03-06T00:00:05.000Z"),
      }),
    });

    // Wait for initial poll to dispatch worker
    await service.runtimeHost.flushEvents();

    // Shutdown should complete after timeout
    await service.shutdown();

    const completeEntry = entries.find((e) => e.event === "shutdown_complete");
    expect(completeEntry).toBeDefined();
    expect(completeEntry).toHaveProperty("timed_out", true);
    expect(completeEntry).toHaveProperty("workers_aborted");
    expect(typeof completeEntry?.duration_ms).toBe("number");
  });
});

describe("startRuntimeService poll_tick_completed", () => {
  it("logs poll_tick_completed event after a successful poll", async () => {
    const tracker = createTracker({ candidates: [] });
    const entries: StructuredLogEntry[] = [];
    const logger = new StructuredLogger([
      {
        write(entry) {
          entries.push(entry);
        },
      },
    ]);

    const service = await startRuntimeService({
      config: createConfig(),
      tracker,
      logger,
      workflowWatcher: null,
      runtimeHost: new OrchestratorRuntimeHost({
        config: createConfig(),
        tracker,
        logger,
        agentRunner: new FakeAgentRunner(),
        now: () => new Date("2026-03-06T00:00:05.000Z"),
      }),
    });

    await service.runtimeHost.flushEvents();
    await service.shutdown();

    const tickEntry = entries.find((e) => e.event === "poll_tick_completed");
    expect(tickEntry).toBeDefined();
    expect(tickEntry).toHaveProperty("dispatched_count");
    expect(tickEntry).toHaveProperty("running_count");
    expect(tickEntry).toHaveProperty("reconciled_stop_requests");
    expect(typeof tickEntry?.duration_ms).toBe("number");
  });

  it("logs poll_tick_completed with dispatched_count reflecting newly dispatched issues", async () => {
    const tracker = createTracker();
    const entries: StructuredLogEntry[] = [];
    const logger = new StructuredLogger([
      {
        write(entry) {
          entries.push(entry);
        },
      },
    ]);

    const service = await startRuntimeService({
      config: createConfig(),
      tracker,
      logger,
      workflowWatcher: null,
      runtimeHost: new OrchestratorRuntimeHost({
        config: createConfig(),
        tracker,
        logger,
        agentRunner: new FakeAgentRunner(),
        now: () => new Date("2026-03-06T00:00:05.000Z"),
      }),
    });

    await service.runtimeHost.flushEvents();
    await service.shutdown();

    const tickEntry = entries.find((e) => e.event === "poll_tick_completed");
    expect(tickEntry).toBeDefined();
    // One issue was dispatched in the initial poll tick
    expect(tickEntry).toHaveProperty("dispatched_count", 1);
  });
});

class FakeAgentRunner {
  onEvent: ((event: AgentRunnerEvent) => void) | undefined;
  readonly runs = new Map<
    string,
    {
      resolve: (result: AgentRunResult) => void;
      reject: (error: Error) => void;
    }
  >();
  readonly abortReasons: string[] = [];

  async run(input: {
    issue: Issue;
    attempt: number | null;
    signal?: AbortSignal;
  }): Promise<AgentRunResult> {
    return await new Promise<AgentRunResult>((resolve, reject) => {
      this.runs.set(input.issue.id, { resolve, reject });
      input.signal?.addEventListener(
        "abort",
        () => {
          const reason =
            typeof input.signal?.reason === "string"
              ? input.signal.reason
              : "aborted";
          this.abortReasons.push(reason);
          reject(new Error(reason));
        },
        { once: true },
      );
    });
  }

  emit(
    issueId: string,
    event: Omit<
      AgentRunnerEvent,
      "issueId" | "issueIdentifier" | "attempt" | "workspacePath" | "turnCount"
    > &
      Partial<Pick<AgentRunnerEvent, "turnCount">>,
  ): void {
    this.onEvent?.({
      ...event,
      issueId,
      issueIdentifier: "ISSUE-1",
      attempt: null,
      workspacePath: "/tmp/workspaces/1",
      turnCount: event.turnCount ?? 0,
    });
  }

  resolve(issueId: string, result: AgentRunResult): void {
    const run = this.runs.get(issueId);
    if (run === undefined) {
      throw new Error(`No fake run registered for ${issueId}.`);
    }
    this.runs.delete(issueId);
    run.resolve(result);
  }

  reject(issueId: string, error: Error): void {
    const run = this.runs.get(issueId);
    if (run === undefined) {
      throw new Error(`No fake run registered for ${issueId}.`);
    }
    this.runs.delete(issueId);
    run.reject(error);
  }
}

function createTracker(input?: { candidates?: Issue[] }) {
  let candidates = input?.candidates ?? [createIssue()];
  let stateSnapshots: IssueStateSnapshot[] = [
    { id: "1", identifier: "ISSUE-1", state: "In Progress" },
  ];

  const tracker: IssueTracker & {
    setCandidates(next: Issue[]): void;
    setStateSnapshots(next: IssueStateSnapshot[]): void;
  } = {
    fetchCandidateIssues: vi.fn(async () => candidates),
    fetchIssuesByStates: vi.fn(async () => []),
    fetchIssueStatesByIds: vi.fn(async () => stateSnapshots),
    setCandidates(next) {
      candidates = next;
    },
    setStateSnapshots(next) {
      stateSnapshots = next;
    },
  };

  return tracker;
}

function createIssue(overrides?: Partial<Issue>): Issue {
  return {
    id: "1",
    identifier: "ISSUE-1",
    title: "Issue 1",
    description: null,
    priority: 1,
    state: "In Progress",
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    ...overrides,
  };
}

function createConfig(): ResolvedWorkflowConfig {
  return {
    workflowPath: "/tmp/WORKFLOW.md",
    promptTemplate: "Prompt",
    tracker: {
      kind: "linear",
      endpoint: "https://api.linear.app/graphql",
      apiKey: "token",
      projectSlug: "project",
      activeStates: ["Todo", "In Progress", "In Review"],
      terminalStates: ["Done", "Canceled"],
    },
    polling: {
      intervalMs: 30_000,
    },
    workspace: {
      root: "/tmp/workspaces",
    },
    hooks: {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 30_000,
    },
    agent: {
      maxConcurrentAgents: 2,
      maxTurns: 5,
      maxRetryBackoffMs: 300_000,
      maxRetryAttempts: 5,
      maxConcurrentAgentsByState: {},
    },
    codex: {
      command: "codex-app-server",
      approvalPolicy: "never",
      threadSandbox: null,
      turnSandboxPolicy: null,
      turnTimeoutMs: 120_000,
      readTimeoutMs: 5_000,
      stallTimeoutMs: 60_000,
    },
    server: {
      port: null,
    },
    observability: {
      dashboardEnabled: true,
      refreshMs: 1_000,
      renderIntervalMs: 16,
    },
    runner: {
      kind: "codex",
      model: null,
    },
    stages: null,
    escalationState: null,
  };
}

function createStagedConfig(): ResolvedWorkflowConfig {
  return {
    ...createConfig(),
    stages: {
      initialStage: "investigate",
      stages: {
        investigate: {
          type: "agent",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework: null,
          reviewers: [],
          transitions: {
            onComplete: null,
            onApprove: null,
            onRework: null,
          },
          linearState: null,
        },
      },
    },
  };
}
