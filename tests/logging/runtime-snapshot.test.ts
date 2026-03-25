import { describe, expect, it } from "vitest";

import {
  type RunningEntry,
  createEmptyLiveSession,
  createInitialOrchestratorState,
} from "../../src/domain/model.js";
import { formatEasternTimestamp } from "../../src/logging/format-timestamp.js";
import {
  STAGE_STALL_THRESHOLDS,
  buildRuntimeSnapshot,
  getStallThreshold,
} from "../../src/logging/runtime-snapshot.js";

describe("runtime snapshot", () => {
  it("includes pipeline_stage and activity_summary in running rows", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    state.running["issue-1"] = createRunningEntry({
      issueId: "issue-1",
      identifier: "ABC-1",
      startedAt: "2026-03-06T10:00:00.000Z",
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: "2026-03-06T10:00:05.000Z",
      lastCodexMessage: "Editing src/foo.ts",
      turnCount: 1,
      codexInputTokens: 10,
      codexOutputTokens: 5,
      codexTotalTokens: 15,
    });
    state.issueStages["issue-1"] = "implement";

    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T10:00:10.000Z"),
    });

    expect(snapshot.running).toHaveLength(1);
    expect(snapshot.running[0]!.pipeline_stage).toBe("implement");
    expect(snapshot.running[0]!.activity_summary).toBe("Editing src/foo.ts");
  });

  it("includes rework_count in running row when greater than zero", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    state.running["issue-1"] = createRunningEntry({
      issueId: "issue-1",
      identifier: "ABC-1",
      startedAt: "2026-03-06T10:00:00.000Z",
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: "2026-03-06T10:00:05.000Z",
      lastCodexMessage: "Fixing review comments",
      turnCount: 3,
      codexInputTokens: 10,
      codexOutputTokens: 5,
      codexTotalTokens: 15,
    });
    state.issueReworkCounts["issue-1"] = 2;

    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T10:00:10.000Z"),
    });

    expect(snapshot.running).toHaveLength(1);
    expect(snapshot.running[0]!.rework_count).toBe(2);
  });

  it("omits rework_count from running row when zero", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    state.running["issue-1"] = createRunningEntry({
      issueId: "issue-1",
      identifier: "ABC-1",
      startedAt: "2026-03-06T10:00:00.000Z",
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: "2026-03-06T10:00:05.000Z",
      lastCodexMessage: "Working",
      turnCount: 1,
      codexInputTokens: 10,
      codexOutputTokens: 5,
      codexTotalTokens: 15,
    });

    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T10:00:10.000Z"),
    });

    expect(snapshot.running).toHaveLength(1);
    expect(snapshot.running[0]!.rework_count).toBeUndefined();
  });

  it("sets pipeline_stage to null when no stage is set for the issue", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    state.running["issue-1"] = createRunningEntry({
      issueId: "issue-1",
      identifier: "ABC-1",
      startedAt: "2026-03-06T10:00:00.000Z",
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: "2026-03-06T10:00:05.000Z",
      lastCodexMessage: "Working",
      turnCount: 1,
      codexInputTokens: 10,
      codexOutputTokens: 5,
      codexTotalTokens: 15,
    });

    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T10:00:10.000Z"),
    });

    expect(snapshot.running[0]!.pipeline_stage).toBeNull();
  });

  it("includes stage_duration_seconds and tokens_per_turn in running rows", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    const now = new Date("2026-03-21T10:05:00.000Z");
    const startedAt = new Date(now.getTime() - 300_000).toISOString(); // 300 seconds ago
    const entry = createRunningEntry({
      issueId: "issue-1",
      identifier: "ABC-1",
      startedAt,
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: "2026-03-21T10:04:59.000Z",
      lastCodexMessage: "Finished",
      turnCount: 10,
      codexInputTokens: 50000,
      codexOutputTokens: 70000,
      codexTotalTokens: 120000,
    });
    entry.totalStageTotalTokens = 120000;
    state.running["issue-1"] = entry;

    const snapshot = buildRuntimeSnapshot(state, { now });

    expect(snapshot.running).toHaveLength(1);
    expect(snapshot.running[0]!.stage_duration_seconds).toBeCloseTo(300, 0);
    expect(snapshot.running[0]!.tokens_per_turn).toBe(12000);
  });

  it("builds a sorted state snapshot with live runtime totals", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    state.codexTotals.inputTokens = 100;
    state.codexTotals.outputTokens = 50;
    state.codexTotals.totalTokens = 150;
    state.codexTotals.secondsRunning = 12.5;
    state.codexRateLimits = {
      requestsRemaining: 7,
      tokensRemaining: 700,
    };
    const entry2 = createRunningEntry({
      issueId: "issue-2",
      identifier: "ZZZ-2",
      startedAt: "2026-03-06T10:00:03.000Z",
      sessionId: "thread-z-turn-1",
      lastCodexEvent: "notification",
      lastCodexTimestamp: "2026-03-06T10:00:04.000Z",
      lastCodexMessage: "Working",
      turnCount: 2,
      codexInputTokens: 12,
      codexOutputTokens: 8,
      codexTotalTokens: 20,
    });
    entry2.totalStageInputTokens = 12;
    entry2.totalStageOutputTokens = 8;
    entry2.totalStageTotalTokens = 20;
    state.running["issue-2"] = entry2;
    const entry1 = createRunningEntry({
      issueId: "issue-1",
      identifier: "AAA-1",
      startedAt: "2026-03-06T10:00:00.000Z",
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: "2026-03-06T10:00:05.000Z",
      lastCodexMessage: "Finished",
      turnCount: 1,
      codexInputTokens: 30,
      codexOutputTokens: 20,
      codexTotalTokens: 50,
    });
    entry1.totalStageInputTokens = 30;
    entry1.totalStageOutputTokens = 20;
    entry1.totalStageTotalTokens = 50;
    state.running["issue-1"] = entry1;
    state.retryAttempts["issue-3"] = {
      issueId: "issue-3",
      identifier: "MMM-3",
      attempt: 2,
      dueAtMs: Date.parse("2026-03-06T10:00:20.000Z"),
      timerHandle: null,
      error: "no available orchestrator slots",
      delayType: "failure",
    };

    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T10:00:10.000Z"),
    });

    expect(snapshot.generated_at).toBe(
      formatEasternTimestamp(new Date("2026-03-06T10:00:10.000Z")),
    );
    expect(snapshot.counts).toEqual({
      running: 2,
      retrying: 1,
      completed: 0,
      failed: 0,
    });
    expect(snapshot.running.map((row) => row.issue_identifier)).toEqual([
      "AAA-1",
      "ZZZ-2",
    ]);
    expect(snapshot.running[0]).toMatchObject({
      issue_id: "issue-1",
      issue_identifier: "AAA-1",
      issue_title: "AAA-1",
      state: "In Progress",
      session_id: "thread-a-turn-1",
      turn_count: 1,
      last_event: "turn_completed",
      last_message: "Finished",
      started_at: "2026-03-06T10:00:00.000Z",
      tokens: {
        input_tokens: 30,
        output_tokens: 20,
        total_tokens: 50,
      },
    });
    // last_event_at is now formatted in Eastern time (ISO-8601 with Eastern offset)
    expect(snapshot.running[0]!.last_event_at).toMatch(/-0[45]:00$/);
    expect(snapshot.retrying).toEqual([
      {
        issue_id: "issue-3",
        issue_identifier: "MMM-3",
        attempt: 2,
        due_at: formatEasternTimestamp(new Date("2026-03-06T10:00:20.000Z")),
        error: "no available orchestrator slots",
      },
    ]);
    expect(snapshot.codex_totals).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
      seconds_running: 29.5,
    });
    expect(snapshot.rate_limits).toEqual({
      requestsRemaining: 7,
      tokensRemaining: 700,
    });
  });

  it("includes cumulative ticket stats in running rows", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });

    // Set up execution history with two completed stages
    state.issueExecutionHistory["issue-1"] = [
      {
        stageName: "investigate",
        durationMs: 10_000,
        totalTokens: 50_000,
        turns: 5,
        outcome: "completed",
      },
      {
        stageName: "implement",
        durationMs: 20_000,
        totalTokens: 80_000,
        turns: 10,
        outcome: "completed",
      },
    ];

    // Running entry with 30K tokens accumulated in the current stage
    const entry = createRunningEntry({
      issueId: "issue-1",
      identifier: "AAA-1",
      startedAt: "2026-03-06T10:00:00.000Z",
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: "2026-03-06T10:00:05.000Z",
      lastCodexMessage: "Finished",
      turnCount: 3,
      codexInputTokens: 10_000,
      codexOutputTokens: 5_000,
      codexTotalTokens: 15_000,
    });
    // Simulate 30K tokens accumulated in the current stage
    entry.totalStageTotalTokens = 30_000;
    state.running["issue-1"] = entry;

    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T10:00:10.000Z"),
    });

    expect(snapshot.running).toHaveLength(1);
    const row = snapshot.running[0]!;

    // total_pipeline_tokens = 50K (investigate) + 80K (implement) + 30K (current stage) = 160K
    expect(row.total_pipeline_tokens).toBe(160_000);

    // execution_history should include the two completed stage records
    expect(row.execution_history).toEqual([
      {
        stageName: "investigate",
        durationMs: 10_000,
        totalTokens: 50_000,
        turns: 5,
        outcome: "completed",
      },
      {
        stageName: "implement",
        durationMs: 20_000,
        totalTokens: 80_000,
        turns: 10,
        outcome: "completed",
      },
    ]);
  });

  it("includes turn_history in running rows", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });

    const entry = createRunningEntry({
      issueId: "issue-1",
      identifier: "AAA-1",
      startedAt: "2026-03-06T10:00:00.000Z",
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: "2026-03-06T10:00:05.000Z",
      lastCodexMessage: "Editing src/foo.ts",
      turnCount: 2,
      codexInputTokens: 500,
      codexOutputTokens: 300,
      codexTotalTokens: 800,
    });
    entry.turnHistory = [
      {
        turnNumber: 1,
        timestamp: "2026-03-06T10:00:03.000Z",
        message: "Checking tests",
        inputTokens: 200,
        outputTokens: 100,
        totalTokens: 300,
        cacheReadTokens: 50,
        reasoningTokens: 20,
        event: "turn_completed",
      },
      {
        turnNumber: 2,
        timestamp: "2026-03-06T10:00:05.000Z",
        message: "Editing src/foo.ts",
        inputTokens: 300,
        outputTokens: 200,
        totalTokens: 500,
        cacheReadTokens: 80,
        reasoningTokens: 30,
        event: "turn_completed",
      },
    ];
    state.running["issue-1"] = entry;

    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T10:00:10.000Z"),
    });

    expect(snapshot.running).toHaveLength(1);
    expect(snapshot.running[0]!.turn_history).toHaveLength(2);
    expect(snapshot.running[0]!.turn_history[0]).toMatchObject({
      turnNumber: 1,
      message: "Checking tests",
      inputTokens: 200,
      cacheReadTokens: 50,
      reasoningTokens: 20,
    });
    expect(snapshot.running[0]!.turn_history[1]).toMatchObject({
      turnNumber: 2,
      message: "Editing src/foo.ts",
    });
  });

  it("populates last_tool_call from the last recentActivity entry", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });

    const entry = createRunningEntry({
      issueId: "issue-1",
      identifier: "AAA-1",
      startedAt: "2026-03-06T10:00:00.000Z",
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: "2026-03-06T10:00:05.000Z",
      lastCodexMessage: "Editing",
      turnCount: 2,
      codexInputTokens: 500,
      codexOutputTokens: 300,
      codexTotalTokens: 800,
    });
    entry.recentActivity = [
      {
        timestamp: "2026-03-06T10:00:03.000Z",
        toolName: "Read",
        context: "model.ts",
        totalTokens: 100,
      },
      {
        timestamp: "2026-03-06T10:00:04.000Z",
        toolName: "Bash",
        context: "npm test",
        totalTokens: 200,
      },
      {
        timestamp: "2026-03-06T10:00:05.000Z",
        toolName: "Grep",
        context: "pattern",
        totalTokens: 150,
      },
    ];
    state.running["issue-1"] = entry;

    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T10:00:10.000Z"),
    });

    expect(snapshot.running[0]!.last_tool_call).toBe("Grep pattern");
  });

  it("sets last_tool_call to tool name only when context is null", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });

    const entry = createRunningEntry({
      issueId: "issue-1",
      identifier: "AAA-1",
      startedAt: "2026-03-06T10:00:00.000Z",
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: "2026-03-06T10:00:05.000Z",
      lastCodexMessage: "Editing",
      turnCount: 1,
      codexInputTokens: 500,
      codexOutputTokens: 300,
      codexTotalTokens: 800,
    });
    entry.recentActivity = [
      {
        timestamp: "2026-03-06T10:00:05.000Z",
        toolName: "Agent",
        context: null,
      },
    ];
    state.running["issue-1"] = entry;

    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T10:00:10.000Z"),
    });

    expect(snapshot.running[0]!.last_tool_call).toBe("Agent");
  });

  it("sets last_tool_call to null when recentActivity is empty", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });

    const entry = createRunningEntry({
      issueId: "issue-1",
      identifier: "AAA-1",
      startedAt: "2026-03-06T10:00:00.000Z",
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: "2026-03-06T10:00:05.000Z",
      lastCodexMessage: "Starting",
      turnCount: 0,
      codexInputTokens: 0,
      codexOutputTokens: 0,
      codexTotalTokens: 0,
    });
    state.running["issue-1"] = entry;

    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T10:00:10.000Z"),
    });

    expect(snapshot.running[0]!.last_tool_call).toBeNull();
  });

  it("includes full token breakdown with cache and reasoning fields in running rows", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });

    const entry = createRunningEntry({
      issueId: "issue-1",
      identifier: "AAA-1",
      startedAt: "2026-03-06T10:00:00.000Z",
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: "2026-03-06T10:00:05.000Z",
      lastCodexMessage: "Working",
      turnCount: 3,
      codexInputTokens: 1000,
      codexOutputTokens: 500,
      codexTotalTokens: 1500,
    });
    // Cumulative stage token fields (used by the dashboard snapshot)
    entry.totalStageInputTokens = 1000;
    entry.totalStageOutputTokens = 500;
    entry.totalStageTotalTokens = 1500;
    entry.totalStageCacheReadTokens = 200;
    entry.totalStageCacheWriteTokens = 150;
    entry.codexReasoningTokens = 75;
    state.running["issue-1"] = entry;

    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T10:00:10.000Z"),
    });

    expect(snapshot.running).toHaveLength(1);
    const row = snapshot.running[0]!;
    expect(row.tokens.input_tokens).toBe(1000);
    expect(row.tokens.output_tokens).toBe(500);
    expect(row.tokens.total_tokens).toBe(1500);
    expect(row.tokens.cache_read_tokens).toBe(200);
    expect(row.tokens.cache_write_tokens).toBe(150);
    expect(row.tokens.reasoning_tokens).toBe(75);
  });

  it("classifies health as green when session is active and token burn is normal", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    const now = new Date("2026-03-21T10:05:00.000Z");
    const recentTimestamp = new Date(now.getTime() - 30_000).toISOString(); // 30s ago
    const entry = createRunningEntry({
      issueId: "issue-1",
      identifier: "ABC-1",
      startedAt: new Date(now.getTime() - 60_000).toISOString(),
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: recentTimestamp,
      lastCodexMessage: "Working",
      turnCount: 5,
      codexInputTokens: 10_000,
      codexOutputTokens: 5_000,
      codexTotalTokens: 15_000,
    });
    entry.totalStageTotalTokens = 15_000;
    state.running["issue-1"] = entry;

    const snapshot = buildRuntimeSnapshot(state, { now });

    expect(snapshot.running[0]!.health).toBe("green");
    expect(snapshot.running[0]!.health_reason).toBeNull();
  });

  it("classifies health as red when session exceeds 80% of stage stall threshold", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    const now = new Date("2026-03-21T10:05:00.000Z");
    // merge stage has 300s threshold; 80% = 240s. 250s > 240s → red
    const stalledTimestamp = new Date(now.getTime() - 250_000).toISOString();
    const entry = createRunningEntry({
      issueId: "issue-1",
      identifier: "ABC-1",
      startedAt: new Date(now.getTime() - 300_000).toISOString(),
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: stalledTimestamp,
      lastCodexMessage: "Working",
      turnCount: 2,
      codexInputTokens: 1_000,
      codexOutputTokens: 500,
      codexTotalTokens: 1_500,
    });
    entry.totalStageTotalTokens = 1_500;
    state.running["issue-1"] = entry;
    state.issueStages["issue-1"] = "merge";

    const snapshot = buildRuntimeSnapshot(state, { now });

    expect(snapshot.running[0]!.health).toBe("red");
    expect(snapshot.running[0]!.health_reason).toContain("stalled");
    expect(snapshot.running[0]!.health_reason).toContain("merge stage");
    expect(snapshot.running[0]!.health_reason).toContain("threshold 300s");
  });

  it("classifies health as yellow when tokens_per_turn exceeds 20000", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    const now = new Date("2026-03-21T10:05:00.000Z");
    const recentTimestamp = new Date(now.getTime() - 10_000).toISOString(); // 10s ago (not stalled)
    const entry = createRunningEntry({
      issueId: "issue-1",
      identifier: "ABC-1",
      startedAt: new Date(now.getTime() - 60_000).toISOString(),
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: recentTimestamp,
      lastCodexMessage: "Working",
      turnCount: 2,
      codexInputTokens: 30_000,
      codexOutputTokens: 12_000,
      codexTotalTokens: 42_001,
    });
    entry.totalStageTotalTokens = 42_001;
    state.running["issue-1"] = entry;

    const snapshot = buildRuntimeSnapshot(state, { now });

    expect(snapshot.running[0]!.health).toBe("yellow");
    expect(snapshot.running[0]!.health_reason).toContain("token");
  });

  it("tokens in running row reflect cumulative stage totals, not per-turn absolute counters", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });

    // Simulate a session where codex absolute counters are small (e.g. start of a new turn)
    // but the stage has already accumulated significant tokens across prior turns
    const entry = createRunningEntry({
      issueId: "issue-1",
      identifier: "AAA-1",
      startedAt: "2026-03-06T10:00:00.000Z",
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "session_started",
      lastCodexTimestamp: "2026-03-06T10:00:05.000Z",
      lastCodexMessage: "Starting",
      turnCount: 5,
      codexInputTokens: 0, // Absolute counters reset at turn boundary
      codexOutputTokens: 0,
      codexTotalTokens: 0,
    });
    // Cumulative stage totals have been accumulating across 4 completed turns
    entry.totalStageInputTokens = 40_000;
    entry.totalStageOutputTokens = 20_000;
    entry.totalStageTotalTokens = 60_000;
    entry.totalStageCacheReadTokens = 5_000;
    entry.totalStageCacheWriteTokens = 2_000;
    entry.codexReasoningTokens = 1_000; // accumulated via +=
    state.running["issue-1"] = entry;

    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T10:00:10.000Z"),
    });

    const row = snapshot.running[0]!;
    // tokens should show cumulative stage values, not the zero absolute counters
    expect(row.tokens.input_tokens).toBe(40_000);
    expect(row.tokens.output_tokens).toBe(20_000);
    expect(row.tokens.total_tokens).toBe(60_000);
    expect(row.tokens.cache_read_tokens).toBe(5_000);
    expect(row.tokens.cache_write_tokens).toBe(2_000);
    expect(row.tokens.reasoning_tokens).toBe(1_000);
  });

  it("includes first_dispatched_at from issueFirstDispatchedAt when set", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    state.running["issue-1"] = createRunningEntry({
      issueId: "issue-1",
      identifier: "ABC-1",
      startedAt: "2026-03-06T10:00:00.000Z",
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: "2026-03-06T10:00:05.000Z",
      lastCodexMessage: "Working",
      turnCount: 1,
      codexInputTokens: 10,
      codexOutputTokens: 5,
      codexTotalTokens: 15,
    });
    state.issueFirstDispatchedAt["issue-1"] = "2026-01-15T08:00:00.000Z";

    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T10:00:10.000Z"),
    });

    expect(snapshot.running).toHaveLength(1);
    expect(snapshot.running[0]!.first_dispatched_at).toBe(
      "2026-01-15T08:00:00.000Z",
    );
  });

  it("falls back to startedAt for first_dispatched_at when issueFirstDispatchedAt is not set", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    state.running["issue-1"] = createRunningEntry({
      issueId: "issue-1",
      identifier: "ABC-1",
      startedAt: "2026-03-06T10:00:00.000Z",
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: "2026-03-06T10:00:05.000Z",
      lastCodexMessage: "Working",
      turnCount: 1,
      codexInputTokens: 10,
      codexOutputTokens: 5,
      codexTotalTokens: 15,
    });

    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T10:00:10.000Z"),
    });

    expect(snapshot.running).toHaveLength(1);
    expect(snapshot.running[0]!.first_dispatched_at).toBe(
      "2026-03-06T10:00:00.000Z",
    );
  });

  it("returns zero total_pipeline_tokens and empty execution_history when no history exists", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });

    state.running["issue-1"] = createRunningEntry({
      issueId: "issue-1",
      identifier: "AAA-1",
      startedAt: "2026-03-06T10:00:00.000Z",
      sessionId: "thread-a-turn-1",
      lastCodexEvent: null,
      lastCodexTimestamp: null,
      lastCodexMessage: null,
      turnCount: 0,
      codexInputTokens: 0,
      codexOutputTokens: 0,
      codexTotalTokens: 0,
    });

    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T10:00:10.000Z"),
    });

    expect(snapshot.running[0]!.total_pipeline_tokens).toBe(0);
    expect(snapshot.running[0]!.execution_history).toEqual([]);
  });

  it("sets issue_title from entry.issue.title", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    const entry = createRunningEntry({
      issueId: "issue-1",
      identifier: "ABC-1",
      startedAt: "2026-03-06T10:00:00.000Z",
      sessionId: "thread-a-turn-1",
      lastCodexEvent: null,
      lastCodexTimestamp: null,
      lastCodexMessage: null,
      turnCount: 0,
      codexInputTokens: 0,
      codexOutputTokens: 0,
      codexTotalTokens: 0,
    });
    entry.issue.title = "Add login page";
    state.running["issue-1"] = entry;

    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T10:00:10.000Z"),
    });

    expect(snapshot.running[0]!.issue_title).toBe("Add login page");
  });

  it("formats last_event_at as Eastern time instead of raw UTC", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    state.running["issue-1"] = createRunningEntry({
      issueId: "issue-1",
      identifier: "ABC-1",
      startedAt: "2026-03-06T10:00:00.000Z",
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: "2026-03-06T15:30:45.000Z",
      lastCodexMessage: "Working",
      turnCount: 1,
      codexInputTokens: 10,
      codexOutputTokens: 5,
      codexTotalTokens: 15,
    });

    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T15:31:00.000Z"),
    });

    const lastEventAt = snapshot.running[0]!.last_event_at!;
    // Should be formatted in Eastern time, not raw UTC (Z suffix)
    expect(lastEventAt).not.toMatch(/Z$/);
    // Should contain Eastern timezone offset (-05:00 for EST)
    expect(lastEventAt).toMatch(/-0[45]:00$/);
    // 15:30:45 UTC = 10:30:45 ET (EST)
    expect(lastEventAt).toContain("10:30:45");
  });

  it("returns null last_event_at when lastCodexTimestamp is null", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    state.running["issue-1"] = createRunningEntry({
      issueId: "issue-1",
      identifier: "ABC-1",
      startedAt: "2026-03-06T10:00:00.000Z",
      sessionId: "thread-a-turn-1",
      lastCodexEvent: null,
      lastCodexTimestamp: null,
      lastCodexMessage: null,
      turnCount: 0,
      codexInputTokens: 0,
      codexOutputTokens: 0,
      codexTotalTokens: 0,
    });

    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T10:00:10.000Z"),
    });

    expect(snapshot.running[0]!.last_event_at).toBeNull();
  });

  it("counts completed and failed issues from state Sets", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    state.completed.add("done-1");
    state.completed.add("done-2");
    state.failed.add("fail-1");

    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T10:00:10.000Z"),
    });

    expect(snapshot.counts.completed).toBe(2);
    expect(snapshot.counts.failed).toBe(1);
  });

  it("returns zero completed/failed when no execution history exists", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });

    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T10:00:10.000Z"),
    });

    expect(snapshot.counts.completed).toBe(0);
    expect(snapshot.counts.failed).toBe(0);
  });

  it("computes pipeline total time from first_dispatched_at for multi-stage issues", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    const now = new Date("2026-03-06T11:00:00.000Z");
    // First dispatched 1 hour ago
    state.issueFirstDispatchedAt["issue-1"] = "2026-03-06T10:00:00.000Z";
    state.issueExecutionHistory["issue-1"] = [
      {
        stageName: "investigate",
        durationMs: 600_000,
        totalTokens: 10_000,
        turns: 5,
        outcome: "success",
      },
    ];
    const entry = createRunningEntry({
      issueId: "issue-1",
      identifier: "ABC-1",
      startedAt: "2026-03-06T10:30:00.000Z", // current stage started 30min ago
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: "2026-03-06T10:59:50.000Z",
      lastCodexMessage: "Working",
      turnCount: 3,
      codexInputTokens: 10,
      codexOutputTokens: 5,
      codexTotalTokens: 15,
    });
    state.running["issue-1"] = entry;

    const snapshot = buildRuntimeSnapshot(state, { now });

    // first_dispatched_at should be 1 hour before now
    expect(snapshot.running[0]!.first_dispatched_at).toBe(
      "2026-03-06T10:00:00.000Z",
    );
    // Pipeline column uses first_dispatched_at for total wall-clock time
    // The dashboard formats elapsed from first_dispatched_at to generated_at
  });

  it("uses started_at as pipeline total time for single-stage issues", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    const now = new Date("2026-03-06T10:05:00.000Z");
    const entry = createRunningEntry({
      issueId: "issue-1",
      identifier: "ABC-1",
      startedAt: "2026-03-06T10:00:00.000Z",
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: "2026-03-06T10:04:50.000Z",
      lastCodexMessage: "Working",
      turnCount: 3,
      codexInputTokens: 10,
      codexOutputTokens: 5,
      codexTotalTokens: 15,
    });
    state.running["issue-1"] = entry;

    const snapshot = buildRuntimeSnapshot(state, { now });

    // For single-stage, first_dispatched_at falls back to started_at
    expect(snapshot.running[0]!.first_dispatched_at).toBe(
      "2026-03-06T10:00:00.000Z",
    );
  });
});

describe("getStallThreshold", () => {
  it("returns stage-specific thresholds for known stages", () => {
    expect(getStallThreshold("investigate")).toBe(600);
    expect(getStallThreshold("implement")).toBe(480);
    expect(getStallThreshold("review")).toBe(600);
    expect(getStallThreshold("merge")).toBe(300);
  });

  it("returns default threshold for unknown stages", () => {
    expect(getStallThreshold("custom-stage")).toBe(480);
  });

  it("returns default threshold for null stage", () => {
    expect(getStallThreshold(null)).toBe(480);
  });
});

describe("stage-aware health classification", () => {
  it("classifies health as yellow at 50%+ of investigate stage threshold", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    const now = new Date("2026-03-21T10:05:00.000Z");
    // investigate threshold=600s; 50% = 300s. 310s > 300s → yellow
    const timestamp = new Date(now.getTime() - 310_000).toISOString();
    const entry = createRunningEntry({
      issueId: "issue-1",
      identifier: "ABC-1",
      startedAt: new Date(now.getTime() - 600_000).toISOString(),
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: timestamp,
      lastCodexMessage: "Exploring codebase",
      turnCount: 3,
      codexInputTokens: 1_000,
      codexOutputTokens: 500,
      codexTotalTokens: 1_500,
    });
    entry.totalStageTotalTokens = 1_500;
    state.running["issue-1"] = entry;
    state.issueStages["issue-1"] = "investigate";

    const snapshot = buildRuntimeSnapshot(state, { now });

    expect(snapshot.running[0]!.health).toBe("yellow");
    expect(snapshot.running[0]!.health_reason).toContain("investigate stage");
    expect(snapshot.running[0]!.health_reason).toContain("threshold 600s");
  });

  it("classifies health as red at 80%+ of investigate stage threshold", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    const now = new Date("2026-03-21T10:05:00.000Z");
    // investigate threshold=600s; 80% = 480s. 500s > 480s → red
    const timestamp = new Date(now.getTime() - 500_000).toISOString();
    const entry = createRunningEntry({
      issueId: "issue-1",
      identifier: "ABC-1",
      startedAt: new Date(now.getTime() - 600_000).toISOString(),
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: timestamp,
      lastCodexMessage: "Exploring codebase",
      turnCount: 3,
      codexInputTokens: 1_000,
      codexOutputTokens: 500,
      codexTotalTokens: 1_500,
    });
    entry.totalStageTotalTokens = 1_500;
    state.running["issue-1"] = entry;
    state.issueStages["issue-1"] = "investigate";

    const snapshot = buildRuntimeSnapshot(state, { now });

    expect(snapshot.running[0]!.health).toBe("red");
    expect(snapshot.running[0]!.health_reason).toContain("stalled");
    expect(snapshot.running[0]!.health_reason).toContain("investigate stage");
  });

  it("classifies health as green within 50% of implement stage threshold", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    const now = new Date("2026-03-21T10:05:00.000Z");
    // implement threshold=480s; 50% = 240s. 200s < 240s → green
    const timestamp = new Date(now.getTime() - 200_000).toISOString();
    const entry = createRunningEntry({
      issueId: "issue-1",
      identifier: "ABC-1",
      startedAt: new Date(now.getTime() - 600_000).toISOString(),
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: timestamp,
      lastCodexMessage: "Writing code",
      turnCount: 3,
      codexInputTokens: 1_000,
      codexOutputTokens: 500,
      codexTotalTokens: 1_500,
    });
    entry.totalStageTotalTokens = 1_500;
    state.running["issue-1"] = entry;
    state.issueStages["issue-1"] = "implement";

    const snapshot = buildRuntimeSnapshot(state, { now });

    expect(snapshot.running[0]!.health).toBe("green");
    expect(snapshot.running[0]!.health_reason).toBeNull();
  });

  it("uses default threshold for unknown stage names", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    const now = new Date("2026-03-21T10:05:00.000Z");
    // default threshold=480s; 80% = 384s. 400s > 384s → red
    const timestamp = new Date(now.getTime() - 400_000).toISOString();
    const entry = createRunningEntry({
      issueId: "issue-1",
      identifier: "ABC-1",
      startedAt: new Date(now.getTime() - 600_000).toISOString(),
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: timestamp,
      lastCodexMessage: "Working",
      turnCount: 3,
      codexInputTokens: 1_000,
      codexOutputTokens: 500,
      codexTotalTokens: 1_500,
    });
    entry.totalStageTotalTokens = 1_500;
    state.running["issue-1"] = entry;
    state.issueStages["issue-1"] = "custom-stage";

    const snapshot = buildRuntimeSnapshot(state, { now });

    expect(snapshot.running[0]!.health).toBe("red");
    expect(snapshot.running[0]!.health_reason).toContain("custom-stage stage");
    expect(snapshot.running[0]!.health_reason).toContain("threshold 480s");
  });

  it("uses default threshold when no stage is set", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    const now = new Date("2026-03-21T10:05:00.000Z");
    // default threshold=480s; 50% = 240s. 250s > 240s → yellow
    const timestamp = new Date(now.getTime() - 250_000).toISOString();
    const entry = createRunningEntry({
      issueId: "issue-1",
      identifier: "ABC-1",
      startedAt: new Date(now.getTime() - 600_000).toISOString(),
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: timestamp,
      lastCodexMessage: "Working",
      turnCount: 3,
      codexInputTokens: 1_000,
      codexOutputTokens: 500,
      codexTotalTokens: 1_500,
    });
    entry.totalStageTotalTokens = 1_500;
    state.running["issue-1"] = entry;
    // No issueStages entry → null stage

    const snapshot = buildRuntimeSnapshot(state, { now });

    expect(snapshot.running[0]!.health).toBe("yellow");
    expect(snapshot.running[0]!.health_reason).toContain("unknown stage");
    expect(snapshot.running[0]!.health_reason).toContain("threshold 480s");
  });

  it("health reason includes seconds of inactivity for yellow", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    const now = new Date("2026-03-21T10:05:00.000Z");
    // review threshold=600s; 50% = 300s. 312s > 300s → yellow
    const timestamp = new Date(now.getTime() - 312_000).toISOString();
    const entry = createRunningEntry({
      issueId: "issue-1",
      identifier: "ABC-1",
      startedAt: new Date(now.getTime() - 600_000).toISOString(),
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: timestamp,
      lastCodexMessage: "Reviewing",
      turnCount: 3,
      codexInputTokens: 1_000,
      codexOutputTokens: 500,
      codexTotalTokens: 1_500,
    });
    entry.totalStageTotalTokens = 1_500;
    state.running["issue-1"] = entry;
    state.issueStages["issue-1"] = "review";

    const snapshot = buildRuntimeSnapshot(state, { now });

    expect(snapshot.running[0]!.health).toBe("yellow");
    expect(snapshot.running[0]!.health_reason).toBe(
      "slow: no activity for 312s (review stage, threshold 600s)",
    );
  });

  it("STAGE_STALL_THRESHOLDS has expected values", () => {
    expect(STAGE_STALL_THRESHOLDS).toEqual({
      investigate: 600,
      implement: 480,
      review: 600,
      merge: 300,
    });
  });
});

describe("formatEasternTimestamp", () => {
  it("formats a UTC date to Eastern time (ISO-8601 with EST offset)", () => {
    // 2026-03-06 is in EST (UTC-5)
    const result = formatEasternTimestamp(new Date("2026-03-06T15:30:45.000Z"));
    // 15:30:45 UTC = 10:30:45 Eastern (EST = UTC-5)
    expect(result).toContain("10:30:45");
    expect(result).toContain("-05:00");
    expect(result).not.toMatch(/Z$/);
  });

  it("handles EDT dates correctly", () => {
    // 2026-07-15 is in EDT (UTC-4)
    const result = formatEasternTimestamp(new Date("2026-07-15T18:00:00.000Z"));
    // 18:00:00 UTC = 14:00:00 Eastern (EDT = UTC-4)
    expect(result).toContain("14:00:00");
    expect(result).toContain("-04:00");
    expect(result).not.toMatch(/Z$/);
  });

  it("returns n/a for invalid dates", () => {
    expect(formatEasternTimestamp(new Date("invalid"))).toBe("n/a");
  });
});

describe("pipeline_tokens cumulative computation", () => {
  it("shows cumulative pipeline totals across completed and current stages", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    state.issueExecutionHistory["issue-1"] = [
      {
        stageName: "investigate",
        durationMs: 10_000,
        totalTokens: 8_000,
        inputTokens: 5_000,
        outputTokens: 2_000,
        cacheReadTokens: 800,
        cacheWriteTokens: 200,
        turns: 5,
        outcome: "completed",
      },
    ];
    const entry = createRunningEntry({
      issueId: "issue-1",
      identifier: "AAA-1",
      startedAt: "2026-03-06T10:00:00.000Z",
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: "2026-03-06T10:00:05.000Z",
      lastCodexMessage: "Implementing",
      turnCount: 3,
      codexInputTokens: 1_000,
      codexOutputTokens: 500,
      codexTotalTokens: 1_500,
    });
    entry.totalStageInputTokens = 3_000;
    entry.totalStageOutputTokens = 1_500;
    entry.totalStageTotalTokens = 5_000;
    entry.totalStageCacheReadTokens = 400;
    entry.totalStageCacheWriteTokens = 100;
    state.running["issue-1"] = entry;
    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T10:00:10.000Z"),
    });
    const row = snapshot.running[0]!;
    expect(row.pipeline_tokens.input_tokens).toBe(8_000);
    expect(row.pipeline_tokens.output_tokens).toBe(3_500);
    expect(row.pipeline_tokens.total_tokens).toBe(13_000);
    expect(row.pipeline_tokens.cache_read_tokens).toBe(1_200);
    expect(row.pipeline_tokens.cache_write_tokens).toBe(300);
    expect(row.total_pipeline_tokens).toBe(13_000);
  });
  it("includes tokens from completed stages via execution_history across stage transitions", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    state.issueExecutionHistory["issue-1"] = [
      {
        stageName: "investigate",
        durationMs: 10_000,
        totalTokens: 50_000,
        inputTokens: 30_000,
        outputTokens: 15_000,
        cacheReadTokens: 4_000,
        cacheWriteTokens: 1_000,
        turns: 5,
        outcome: "completed",
      },
      {
        stageName: "implement",
        durationMs: 20_000,
        totalTokens: 80_000,
        inputTokens: 50_000,
        outputTokens: 25_000,
        cacheReadTokens: 3_000,
        cacheWriteTokens: 2_000,
        turns: 10,
        outcome: "completed",
      },
    ];
    const entry = createRunningEntry({
      issueId: "issue-1",
      identifier: "AAA-1",
      startedAt: "2026-03-06T10:00:00.000Z",
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: "2026-03-06T10:00:05.000Z",
      lastCodexMessage: "Reviewing",
      turnCount: 0,
      codexInputTokens: 0,
      codexOutputTokens: 0,
      codexTotalTokens: 0,
    });
    entry.totalStageInputTokens = 0;
    entry.totalStageOutputTokens = 0;
    entry.totalStageTotalTokens = 0;
    entry.totalStageCacheReadTokens = 0;
    entry.totalStageCacheWriteTokens = 0;
    state.running["issue-1"] = entry;
    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T10:00:10.000Z"),
    });
    const row = snapshot.running[0]!;
    expect(row.pipeline_tokens.input_tokens).toBe(80_000);
    expect(row.pipeline_tokens.output_tokens).toBe(40_000);
    expect(row.pipeline_tokens.total_tokens).toBe(130_000);
    expect(row.pipeline_tokens.cache_read_tokens).toBe(7_000);
    expect(row.pipeline_tokens.cache_write_tokens).toBe(3_000);
    expect(row.total_pipeline_tokens).toBe(130_000);
  });
  it("shows current stage tokens only when no execution_history exists (first stage)", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    const entry = createRunningEntry({
      issueId: "issue-1",
      identifier: "AAA-1",
      startedAt: "2026-03-06T10:00:00.000Z",
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: "2026-03-06T10:00:05.000Z",
      lastCodexMessage: "Investigating",
      turnCount: 2,
      codexInputTokens: 1_000,
      codexOutputTokens: 500,
      codexTotalTokens: 1_500,
    });
    entry.totalStageInputTokens = 4_000;
    entry.totalStageOutputTokens = 2_000;
    entry.totalStageTotalTokens = 7_000;
    entry.totalStageCacheReadTokens = 600;
    entry.totalStageCacheWriteTokens = 400;
    state.running["issue-1"] = entry;
    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T10:00:10.000Z"),
    });
    const row = snapshot.running[0]!;
    expect(row.pipeline_tokens.input_tokens).toBe(4_000);
    expect(row.pipeline_tokens.output_tokens).toBe(2_000);
    expect(row.pipeline_tokens.total_tokens).toBe(7_000);
    expect(row.pipeline_tokens.cache_read_tokens).toBe(600);
    expect(row.pipeline_tokens.cache_write_tokens).toBe(400);
    expect(row.total_pipeline_tokens).toBe(7_000);
  });
  it("handles execution_history with missing optional token fields (backward compat)", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    state.issueExecutionHistory["issue-1"] = [
      {
        stageName: "investigate",
        durationMs: 10_000,
        totalTokens: 50_000,
        turns: 5,
        outcome: "completed",
      },
    ];
    const entry = createRunningEntry({
      issueId: "issue-1",
      identifier: "AAA-1",
      startedAt: "2026-03-06T10:00:00.000Z",
      sessionId: "thread-a-turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexTimestamp: "2026-03-06T10:00:05.000Z",
      lastCodexMessage: "Implementing",
      turnCount: 1,
      codexInputTokens: 500,
      codexOutputTokens: 250,
      codexTotalTokens: 750,
    });
    entry.totalStageInputTokens = 2_000;
    entry.totalStageOutputTokens = 1_000;
    entry.totalStageTotalTokens = 3_000;
    entry.totalStageCacheReadTokens = 100;
    entry.totalStageCacheWriteTokens = 50;
    state.running["issue-1"] = entry;
    const snapshot = buildRuntimeSnapshot(state, {
      now: new Date("2026-03-06T10:00:10.000Z"),
    });
    const row = snapshot.running[0]!;
    expect(row.pipeline_tokens.input_tokens).toBe(2_000);
    expect(row.pipeline_tokens.output_tokens).toBe(1_000);
    expect(row.pipeline_tokens.total_tokens).toBe(53_000);
    expect(row.pipeline_tokens.cache_read_tokens).toBe(100);
    expect(row.pipeline_tokens.cache_write_tokens).toBe(50);
  });
});

function createRunningEntry(input: {
  issueId: string;
  identifier: string;
  startedAt: string;
  sessionId: string;
  lastCodexEvent: string | null;
  lastCodexTimestamp: string | null;
  lastCodexMessage: string | null;
  turnCount: number;
  codexInputTokens: number;
  codexOutputTokens: number;
  codexTotalTokens: number;
}): RunningEntry {
  return {
    ...createEmptyLiveSession(),
    sessionId: input.sessionId,
    threadId: input.sessionId.split("-turn-")[0] ?? null,
    turnId: input.sessionId.split("-").at(-1) ?? null,
    lastCodexEvent: input.lastCodexEvent,
    lastCodexTimestamp: input.lastCodexTimestamp,
    lastCodexMessage: input.lastCodexMessage,
    turnCount: input.turnCount,
    codexInputTokens: input.codexInputTokens,
    codexOutputTokens: input.codexOutputTokens,
    codexTotalTokens: input.codexTotalTokens,
    issue: {
      id: input.issueId,
      identifier: input.identifier,
      title: input.identifier,
      description: null,
      priority: null,
      state: "In Progress",
      branchName: null,
      url: null,
      labels: [],
      blockedBy: [],
      createdAt: null,
      updatedAt: null,
    },
    identifier: input.identifier,
    retryAttempt: null,
    startedAt: input.startedAt,
    workerHandle: null,
    monitorHandle: null,
    failureReason: null,
  };
}
