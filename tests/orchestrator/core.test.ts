import { describe, expect, it } from "vitest";

import type { ResolvedWorkflowConfig } from "../../src/config/types.js";
import type { Issue } from "../../src/domain/model.js";
import {
  OrchestratorCore,
  type OrchestratorCoreOptions,
  computeFailureRetryDelayMs,
  sortIssuesForDispatch,
} from "../../src/orchestrator/core.js";
import type {
  IssueStateSnapshot,
  IssueTracker,
} from "../../src/tracker/tracker.js";

describe("orchestrator core", () => {
  it("sorts dispatch candidates by priority, age, and identifier", () => {
    const issues = sortIssuesForDispatch([
      createIssue({
        id: "3",
        identifier: "ISSUE-3",
        priority: 2,
        createdAt: "2026-03-05T00:00:00.000Z",
      }),
      createIssue({
        id: "2",
        identifier: "ISSUE-2",
        priority: 1,
        createdAt: "2026-03-04T00:00:00.000Z",
      }),
      createIssue({
        id: "1",
        identifier: "ISSUE-1",
        priority: 1,
        createdAt: "2026-03-03T00:00:00.000Z",
      }),
    ]);

    expect(issues.map((issue) => issue.id)).toEqual(["1", "2", "3"]);
  });

  it("rejects Todo issues with non-terminal blockers and allows terminal blockers", () => {
    const orchestrator = createOrchestrator();

    expect(
      orchestrator.isDispatchEligible(
        createIssue({
          id: "todo-1",
          identifier: "ISSUE-1",
          state: "Todo",
          blockedBy: [{ id: "b1", identifier: "B-1", state: "In Progress" }],
        }),
      ),
    ).toBe(false);

    expect(
      orchestrator.isDispatchEligible(
        createIssue({
          id: "todo-2",
          identifier: "ISSUE-2",
          state: "Todo",
          blockedBy: [{ id: "b2", identifier: "B-2", state: "Done" }],
        }),
      ),
    ).toBe(true);
  });

  it("dispatches eligible issues on poll tick until slots are exhausted", async () => {
    const orchestrator = createOrchestrator({
      tracker: createTracker({
        candidates: [
          createIssue({ id: "1", identifier: "ISSUE-1", priority: 1 }),
          createIssue({ id: "2", identifier: "ISSUE-2", priority: 2 }),
        ],
      }),
    });

    const result = await orchestrator.pollTick();

    expect(result.validation.ok).toBe(true);
    expect(result.dispatchedIssueIds).toEqual(["1", "2"]);
    expect(Object.keys(orchestrator.getState().running)).toEqual(["1", "2"]);
    expect([...orchestrator.getState().claimed]).toEqual(["1", "2"]);
  });

  it("updates running issue state during reconciliation", async () => {
    const tracker = createTracker({
      statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Review" }],
    });
    const orchestrator = createOrchestrator({ tracker });

    await orchestrator.pollTick();
    const result = await orchestrator.pollTick();

    expect(result.stopRequests).toEqual([]);
    expect(orchestrator.getState().running["1"]?.issue.state).toBe("In Review");
  });

  it("requests stop without cleanup when a running issue becomes non-active", async () => {
    const stopRequests: unknown[] = [];
    const tracker = createTracker({
      statesById: [{ id: "1", identifier: "ISSUE-1", state: "Backlog" }],
    });
    const orchestrator = createOrchestrator({
      tracker,
      stopRunningIssue: async (input) => {
        stopRequests.push(input);
      },
    });

    await orchestrator.pollTick();
    const result = await orchestrator.pollTick();

    expect(result.stopRequests).toEqual([
      {
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        cleanupWorkspace: false,
        reason: "inactive_state",
      },
    ]);
    expect(stopRequests).toHaveLength(1);
  });

  it("requests stop with cleanup when a running issue becomes terminal", async () => {
    const tracker = createTracker({
      statesById: [{ id: "1", identifier: "ISSUE-1", state: "Done" }],
    });
    const orchestrator = createOrchestrator({ tracker });

    await orchestrator.pollTick();
    const result = await orchestrator.pollTick();

    expect(result.stopRequests).toEqual([
      {
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        cleanupWorkspace: true,
        reason: "terminal_state",
      },
    ]);
  });

  it("requests stop when reconciliation no longer returns a running issue", async () => {
    const tracker = createTracker({
      statesById: [],
    });
    const orchestrator = createOrchestrator({ tracker });

    await orchestrator.pollTick();
    const result = await orchestrator.pollTick();

    expect(result.stopRequests).toEqual([
      {
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        cleanupWorkspace: false,
        reason: "inactive_state",
      },
    ]);
  });

  it("treats reconciliation with no running issues as a no-op", async () => {
    const tracker = createTracker({
      candidates: [],
      statesById: [],
    });
    const orchestrator = createOrchestrator({ tracker });

    const result = await orchestrator.pollTick();

    expect(result.stopRequests).toEqual([]);
    expect(result.reconciliationFetchFailed).toBe(false);
  });

  it("schedules continuation retry after a normal worker exit", async () => {
    const timers = createFakeTimerScheduler();
    const orchestrator = createOrchestrator({ timerScheduler: timers });

    await orchestrator.pollTick();
    const retryEntry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      endedAt: new Date("2026-03-06T00:00:05.000Z"),
    });

    expect(retryEntry).toMatchObject({
      issueId: "1",
      identifier: "ISSUE-1",
      attempt: 1,
      error: null,
      dueAtMs: Date.parse("2026-03-06T00:00:06.000Z"),
    });
    expect(timers.scheduled[0]?.delayMs).toBe(1_000);
  });

  it("schedules exponential backoff retries for abnormal exits and caps the delay", async () => {
    const timers = createFakeTimerScheduler();
    const orchestrator = createOrchestrator({
      timerScheduler: timers,
      config: createConfig({
        agent: { maxRetryBackoffMs: 30_000 },
      }),
    });

    await orchestrator.pollTick();
    const retryEntry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: "turn failed",
    });

    expect(retryEntry).toMatchObject({
      issueId: "1",
      identifier: "ISSUE-1",
      attempt: 1,
      error: "worker exited: turn failed",
    });
    expect(timers.scheduled[0]?.delayMs).toBe(10_000);
    expect(computeFailureRetryDelayMs(3, 30_000)).toBe(30_000);
  });

  it("applies codex session events to the running entry and aggregate counters", async () => {
    const orchestrator = createOrchestrator();

    await orchestrator.pollTick();
    const result = orchestrator.onCodexEvent({
      issueId: "1",
      event: {
        event: "turn_completed",
        timestamp: "2026-03-06T00:00:04.000Z",
        codexAppServerPid: "1001",
        sessionId: "thread-1-turn-1",
        threadId: "thread-1",
        turnId: "turn-1",
        usage: {
          inputTokens: 13,
          outputTokens: 8,
          totalTokens: 21,
        },
        rateLimits: {
          requestsRemaining: 9,
        },
        message: "turn completed",
      },
    });

    expect(result).toEqual({ applied: true });
    expect(orchestrator.getState().running["1"]).toMatchObject({
      sessionId: "thread-1-turn-1",
      threadId: "thread-1",
      turnId: "turn-1",
      lastCodexEvent: "turn_completed",
      lastCodexMessage: "turn completed",
      codexTotalTokens: 21,
    });
    expect(orchestrator.getState().codexTotals.totalTokens).toBe(21);
    expect(orchestrator.getState().codexRateLimits).toEqual({
      requestsRemaining: 9,
    });
  });

  it("requeues retry timers when slots are exhausted", async () => {
    const timers = createFakeTimerScheduler();
    const tracker = createTracker({
      candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
    });
    const orchestrator = createOrchestrator({
      tracker,
      timerScheduler: timers,
      config: createConfig({
        agent: { maxConcurrentAgents: 0 },
      }),
    });

    // Create a queued retry entry without dispatching the issue.
    orchestrator.getState().claimed.add("1");
    orchestrator.getState().retryAttempts["1"] = {
      issueId: "1",
      identifier: "ISSUE-1",
      attempt: 1,
      dueAtMs: Date.parse("2026-03-06T00:00:00.000Z"),
      timerHandle: null,
      error: "previous failure",
    };

    const result = await orchestrator.onRetryTimer("1");

    expect(result.dispatched).toBe(false);
    expect(result.released).toBe(false);
    expect(result.retryEntry).toMatchObject({
      issueId: "1",
      attempt: 2,
      identifier: "ISSUE-1",
      error: "no available orchestrator slots",
    });
  });

  it("requests stop for stalled sessions before tracker refresh", async () => {
    const stopCalls: Array<{ issueId: string; reason: string }> = [];
    const tracker = createTracker({
      statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
    });
    const orchestrator = createOrchestrator({
      tracker,
      now: () => new Date("2026-03-06T00:10:00.000Z"),
      config: createConfig({
        codex: { stallTimeoutMs: 60_000 },
      }),
      stopRunningIssue: async (input) => {
        stopCalls.push({ issueId: input.issueId, reason: input.reason });
      },
    });

    await orchestrator.pollTick();
    const runningEntry = orchestrator.getState().running["1"];
    if (runningEntry === undefined) {
      throw new Error("expected running entry for ISSUE-1");
    }
    runningEntry.startedAt = "2026-03-06T00:00:00.000Z";
    const result = await orchestrator.pollTick();

    expect(result.stopRequests).toContainEqual({
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      cleanupWorkspace: false,
      reason: "stall_timeout",
    });
    expect(stopCalls).toContainEqual({
      issueId: "1",
      reason: "stall_timeout",
    });
  });
});

describe("orchestrator core integration flows", () => {
  it("redispatches a retried issue through a fake runner boundary after an abnormal exit", async () => {
    const harness = createIntegrationHarness();

    const initialTick = await harness.orchestrator.pollTick();

    expect(initialTick.dispatchedIssueIds).toEqual(["1"]);
    expect(harness.spawnCalls).toEqual([
      {
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        attempt: null,
      },
    ]);
    expect([...harness.orchestrator.getState().claimed]).toEqual(["1"]);

    const retryEntry = harness.orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: "turn failed",
    });

    expect(retryEntry).toMatchObject({
      issueId: "1",
      attempt: 1,
      error: "worker exited: turn failed",
    });
    expect(harness.orchestrator.getState().running).toEqual({});

    const retryResult = await harness.orchestrator.onRetryTimer("1");

    expect(retryResult).toEqual({
      dispatched: true,
      released: false,
      retryEntry: null,
    });
    expect(harness.spawnCalls).toEqual([
      {
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        attempt: null,
      },
      {
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        attempt: 1,
      },
    ]);
    expect(harness.orchestrator.getState().running["1"]?.retryAttempt).toBe(1);
    expect([...harness.orchestrator.getState().claimed]).toEqual(["1"]);
  });

  it("requests terminal cleanup through the fake runner boundary and releases the claim once the issue disappears", async () => {
    const harness = createIntegrationHarness();

    await harness.orchestrator.pollTick();
    harness.setStateSnapshots([
      { id: "1", identifier: "ISSUE-1", state: "Done" },
    ]);

    const reconcileTick = await harness.orchestrator.pollTick();

    expect(reconcileTick.stopRequests).toEqual([
      {
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        cleanupWorkspace: true,
        reason: "terminal_state",
      },
    ]);
    expect(harness.stopCalls).toEqual([
      {
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        cleanupWorkspace: true,
        reason: "terminal_state",
      },
    ]);

    harness.orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: "stopped after terminal reconciliation",
    });
    harness.setCandidates([]);

    const retryResult = await harness.orchestrator.onRetryTimer("1");

    expect(retryResult).toEqual({
      dispatched: false,
      released: true,
      retryEntry: null,
    });
    expect([...harness.orchestrator.getState().claimed]).toEqual([]);
    expect(harness.orchestrator.getState().retryAttempts).toEqual({});
  });

  it("stops a stalled worker through the fake runner boundary and releases it when the issue is no longer active", async () => {
    const harness = createIntegrationHarness({
      now: "2026-03-06T00:10:00.000Z",
      config: createConfig({
        codex: { stallTimeoutMs: 60_000 },
      }),
    });

    await harness.orchestrator.pollTick();
    const runningEntry = harness.orchestrator.getState().running["1"];
    if (runningEntry === undefined) {
      throw new Error("expected running entry for ISSUE-1");
    }
    runningEntry.startedAt = "2026-03-06T00:00:00.000Z";

    const reconcileTick = await harness.orchestrator.pollTick();

    expect(reconcileTick.stopRequests).toContainEqual({
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      cleanupWorkspace: false,
      reason: "stall_timeout",
    });
    expect(harness.stopCalls).toContainEqual({
      issueId: "1",
      issueIdentifier: "ISSUE-1",
      cleanupWorkspace: false,
      reason: "stall_timeout",
    });

    harness.orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: "stalled",
    });
    harness.setCandidates([
      createIssue({
        id: "1",
        identifier: "ISSUE-1",
        state: "Backlog",
      }),
    ]);

    const retryResult = await harness.orchestrator.onRetryTimer("1");

    expect(retryResult).toEqual({
      dispatched: false,
      released: true,
      retryEntry: null,
    });
    expect([...harness.orchestrator.getState().claimed]).toEqual([]);
    expect(harness.orchestrator.getState().retryAttempts).toEqual({});
  });
});

describe("max retry safety net", () => {
  it("retries normally when attempt is under the max limit", async () => {
    const timers = createFakeTimerScheduler();
    const orchestrator = createOrchestrator({
      timerScheduler: timers,
      config: createConfig({ agent: { maxRetryAttempts: 3 } }),
    });

    await orchestrator.pollTick();
    // Simulate abnormal exit — attempt will be 1 (under limit of 3)
    const retryEntry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: "turn failed",
    });

    expect(retryEntry).not.toBeNull();
    expect(retryEntry).toMatchObject({
      issueId: "1",
      attempt: 1,
      error: "worker exited: turn failed",
    });
    expect(orchestrator.getState().completed.has("1")).toBe(false);
    expect(orchestrator.getState().claimed.has("1")).toBe(true);
  });

  it("escalates when failure retry attempt exceeds the max limit", async () => {
    const escalationComments: Array<{ issueId: string; body: string }> = [];
    const escalationStates: Array<{ issueId: string; state: string }> = [];
    const timers = createFakeTimerScheduler();

    const orchestrator = new OrchestratorCore({
      config: createConfig({
        agent: { maxRetryAttempts: 2 },
      }),
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      postComment: async (issueId, body) => {
        escalationComments.push({ issueId, body });
      },
      updateIssueState: async (issueId, _identifier, state) => {
        escalationStates.push({ issueId, state });
      },
      timerScheduler: timers,
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();

    // Simulate: attempt 1 (under limit of 2)
    const retry1 = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: "turn failed",
    });
    expect(retry1).not.toBeNull();
    expect(retry1).toMatchObject({ attempt: 1 });

    // Fire retry timer → redispatch → exit again → attempt 2 (still at limit)
    const retryResult = await orchestrator.onRetryTimer("1");
    expect(retryResult.dispatched).toBe(true);

    const retry2 = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: "turn failed again",
    });
    expect(retry2).not.toBeNull();
    expect(retry2).toMatchObject({ attempt: 2 });

    // Fire retry timer → redispatch → exit again → attempt 3 (exceeds limit of 2)
    const retryResult2 = await orchestrator.onRetryTimer("1");
    expect(retryResult2.dispatched).toBe(true);

    const retry3 = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: "turn failed yet again",
    });

    // Should be null — escalated
    expect(retry3).toBeNull();
    expect(orchestrator.getState().completed.has("1")).toBe(true);
    expect(orchestrator.getState().claimed.has("1")).toBe(false);
    expect(orchestrator.getState().retryAttempts).not.toHaveProperty("1");

    // Verify escalation side effects were fired
    expect(escalationComments).toHaveLength(1);
    expect(escalationComments[0]?.body).toContain(
      "Max retry attempts (2) exceeded",
    );
  });

  it("escalates on onRetryTimer failure retry when attempt exceeds limit", async () => {
    const escalationComments: Array<{ issueId: string; body: string }> = [];
    const timers = createFakeTimerScheduler();

    const orchestrator = new OrchestratorCore({
      config: createConfig({
        agent: { maxConcurrentAgents: 0, maxRetryAttempts: 2 },
      }),
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      postComment: async (issueId, body) => {
        escalationComments.push({ issueId, body });
      },
      timerScheduler: timers,
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    // Manually create a retry entry at attempt 2 (the limit)
    orchestrator.getState().claimed.add("1");
    orchestrator.getState().retryAttempts["1"] = {
      issueId: "1",
      identifier: "ISSUE-1",
      attempt: 2,
      dueAtMs: Date.parse("2026-03-06T00:00:00.000Z"),
      timerHandle: null,
      error: "previous failure",
    };

    // When onRetryTimer fires and slots are exhausted, it calls scheduleRetry
    // with attempt 3, which exceeds maxRetryAttempts=2
    const result = await orchestrator.onRetryTimer("1");

    expect(result.dispatched).toBe(false);
    expect(result.retryEntry).toBeNull();
    expect(orchestrator.getState().completed.has("1")).toBe(true);
    expect(orchestrator.getState().claimed.has("1")).toBe(false);
    expect(escalationComments).toHaveLength(1);
    expect(escalationComments[0]?.body).toContain(
      "Max retry attempts (2) exceeded",
    );
  });

  it("does not count continuation retries against the max limit", async () => {
    const timers = createFakeTimerScheduler();
    const orchestrator = createOrchestrator({
      timerScheduler: timers,
      config: createConfig({ agent: { maxRetryAttempts: 1 } }),
    });

    await orchestrator.pollTick();

    // Normal exit with no failure signal → continuation retry with attempt=1
    const retryEntry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      endedAt: new Date("2026-03-06T00:00:05.000Z"),
    });

    // Should still succeed even though maxRetryAttempts=1
    // because continuation retries don't count against the limit
    expect(retryEntry).not.toBeNull();
    expect(retryEntry).toMatchObject({
      issueId: "1",
      attempt: 1,
      error: null,
    });
    expect(orchestrator.getState().completed.has("1")).toBe(true);
    expect(orchestrator.getState().claimed.has("1")).toBe(true);
  });

  it("respects the limit for verify failure signals", async () => {
    const escalationComments: Array<{ issueId: string; body: string }> = [];

    const orchestrator = new OrchestratorCore({
      config: createConfig({
        agent: { maxRetryAttempts: 1 },
      }),
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      postComment: async (issueId, body) => {
        escalationComments.push({ issueId, body });
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();

    // First exit with verify failure → attempt 1 (at limit, still OK)
    const retry1 = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: verify]",
    });
    expect(retry1).not.toBeNull();
    expect(retry1).toMatchObject({ attempt: 1 });

    // Fire retry, redispatch, exit with verify failure again → attempt 2 (exceeds limit=1)
    const retryResult = await orchestrator.onRetryTimer("1");
    expect(retryResult.dispatched).toBe(true);

    const retry2 = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: verify]",
    });

    expect(retry2).toBeNull();
    expect(orchestrator.getState().completed.has("1")).toBe(true);
    expect(orchestrator.getState().claimed.has("1")).toBe(false);
    expect(escalationComments).toHaveLength(1);
    expect(escalationComments[0]?.body).toContain(
      "Max retry attempts (1) exceeded",
    );
  });

  it("respects the limit for infra failure signals", async () => {
    const escalationComments: Array<{ issueId: string; body: string }> = [];

    const orchestrator = new OrchestratorCore({
      config: createConfig({
        agent: { maxRetryAttempts: 1 },
      }),
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      postComment: async (issueId, body) => {
        escalationComments.push({ issueId, body });
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();

    // First exit with infra failure → attempt 1 (at limit)
    const retry1 = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: infra]",
    });
    expect(retry1).not.toBeNull();

    const retryResult = await orchestrator.onRetryTimer("1");
    expect(retryResult.dispatched).toBe(true);

    // Second exit with infra failure → attempt 2 (exceeds limit=1)
    const retry2 = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: infra]",
    });

    expect(retry2).toBeNull();
    expect(orchestrator.getState().completed.has("1")).toBe(true);
    expect(escalationComments).toHaveLength(1);
  });

  it("defaults maxRetryAttempts to 5 from config resolver", () => {
    const config = createConfig();
    expect(config.agent.maxRetryAttempts).toBe(5);
  });
});

describe("completed issue resume guard", () => {
  it("does NOT re-dispatch a completed issue still in 'In Review' state", () => {
    const config = createConfig({
      agent: { maxConcurrentAgents: 2 },
    });
    // Include Resume and Blocked in active_states for this test
    config.tracker.activeStates = [
      "Todo",
      "In Progress",
      "In Review",
      "Blocked",
      "Resume",
    ];
    config.escalationState = "Blocked";

    const orchestrator = createOrchestrator({ config });

    // Mark issue as completed (simulates having finished the pipeline)
    orchestrator.getState().completed.add("1");

    // Issue is still "In Review" on the tracker — should NOT be re-dispatched
    const eligible = orchestrator.isDispatchEligible(
      createIssue({ id: "1", identifier: "ISSUE-1", state: "In Review" }),
    );

    expect(eligible).toBe(false);
    // completed flag should NOT be cleared
    expect(orchestrator.getState().completed.has("1")).toBe(true);
  });

  it("does NOT re-dispatch a completed issue still in 'In Progress' state", () => {
    const config = createConfig({
      agent: { maxConcurrentAgents: 2 },
    });
    config.tracker.activeStates = [
      "Todo",
      "In Progress",
      "In Review",
      "Blocked",
      "Resume",
    ];
    config.escalationState = "Blocked";

    const orchestrator = createOrchestrator({ config });
    orchestrator.getState().completed.add("1");

    const eligible = orchestrator.isDispatchEligible(
      createIssue({ id: "1", identifier: "ISSUE-1", state: "In Progress" }),
    );

    expect(eligible).toBe(false);
    expect(orchestrator.getState().completed.has("1")).toBe(true);
  });

  it("re-dispatches a completed issue moved to 'Resume' state", () => {
    const config = createConfig({
      agent: { maxConcurrentAgents: 2 },
    });
    config.tracker.activeStates = [
      "Todo",
      "In Progress",
      "In Review",
      "Blocked",
      "Resume",
    ];
    config.escalationState = "Blocked";

    const orchestrator = createOrchestrator({ config });
    orchestrator.getState().completed.add("1");

    const eligible = orchestrator.isDispatchEligible(
      createIssue({ id: "1", identifier: "ISSUE-1", state: "Resume" }),
    );

    expect(eligible).toBe(true);
    // completed flag should be cleared
    expect(orchestrator.getState().completed.has("1")).toBe(false);
  });

  it("re-dispatches a completed issue moved to 'Todo' state", () => {
    const config = createConfig({
      agent: { maxConcurrentAgents: 2 },
    });
    config.tracker.activeStates = [
      "Todo",
      "In Progress",
      "In Review",
      "Blocked",
      "Resume",
    ];
    config.escalationState = "Blocked";

    const orchestrator = createOrchestrator({ config });
    orchestrator.getState().completed.add("1");

    const eligible = orchestrator.isDispatchEligible(
      createIssue({ id: "1", identifier: "ISSUE-1", state: "Todo" }),
    );

    expect(eligible).toBe(true);
    expect(orchestrator.getState().completed.has("1")).toBe(false);
  });

  it("skips terminal_state stop for worker in final active stage (merge → done)", async () => {
    const config = createConfig();
    config.stages = {
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
          transitions: { onComplete: "merge", onApprove: null, onRework: null },
          linearState: null,
        },
        merge: {
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
          transitions: { onComplete: "done", onApprove: null, onRework: null },
          linearState: null,
        },
        done: {
          type: "terminal",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework: null,
          reviewers: [],
          transitions: { onComplete: null, onApprove: null, onRework: null },
          linearState: "Done",
        },
      },
    };
    const harness = createIntegrationHarness({ config });

    // Dispatch the issue, which puts it in running state
    await harness.orchestrator.pollTick();

    // Simulate: worker is in the "merge" stage (final active stage before terminal "done")
    harness.orchestrator.getState().issueStages["1"] = "merge";

    // Issue transitions to Done (e.g., advanceStage fired updateIssueState)
    harness.setStateSnapshots([
      { id: "1", identifier: "ISSUE-1", state: "Done" },
    ]);

    const result = await harness.orchestrator.pollTick();

    // Worker should NOT be stopped — it's in the final active stage
    expect(result.stopRequests).toEqual([]);
    expect(harness.stopCalls).toEqual([]);
  });

  it("stops worker in non-final stage when issue reaches terminal state", async () => {
    const config = createConfig();
    config.stages = {
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
          transitions: { onComplete: "merge", onApprove: null, onRework: null },
          linearState: null,
        },
        merge: {
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
          transitions: { onComplete: "done", onApprove: null, onRework: null },
          linearState: null,
        },
        done: {
          type: "terminal",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework: null,
          reviewers: [],
          transitions: { onComplete: null, onApprove: null, onRework: null },
          linearState: "Done",
        },
      },
    };
    const harness = createIntegrationHarness({ config });

    // Dispatch the issue
    await harness.orchestrator.pollTick();

    // Worker is in "investigate" stage (NOT the final active stage)
    harness.orchestrator.getState().issueStages["1"] = "investigate";

    // Issue manually moved to Done by a human
    harness.setStateSnapshots([
      { id: "1", identifier: "ISSUE-1", state: "Done" },
    ]);

    const result = await harness.orchestrator.pollTick();

    // Worker SHOULD be stopped — investigate is not the final active stage
    expect(result.stopRequests).toEqual([
      {
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        cleanupWorkspace: true,
        reason: "terminal_state",
      },
    ]);
  });

  it("does NOT re-dispatch a completed issue in escalation state ('Blocked')", () => {
    const config = createConfig({
      agent: { maxConcurrentAgents: 2 },
    });
    config.tracker.activeStates = [
      "Todo",
      "In Progress",
      "In Review",
      "Blocked",
      "Resume",
    ];
    config.escalationState = "Blocked";

    const orchestrator = createOrchestrator({ config });
    orchestrator.getState().completed.add("1");

    const eligible = orchestrator.isDispatchEligible(
      createIssue({ id: "1", identifier: "ISSUE-1", state: "Blocked" }),
    );

    expect(eligible).toBe(false);
    expect(orchestrator.getState().completed.has("1")).toBe(true);
  });
});

function createOrchestrator(overrides?: {
  config?: ResolvedWorkflowConfig;
  tracker?: IssueTracker;
  timerScheduler?: ReturnType<typeof createFakeTimerScheduler>;
  stopRunningIssue?: OrchestratorCoreOptions["stopRunningIssue"];
  now?: () => Date;
}) {
  const tracker =
    overrides?.tracker ??
    createTracker({
      candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
      statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
    });
  const options: OrchestratorCoreOptions = {
    config: overrides?.config ?? createConfig(),
    tracker,
    spawnWorker: async () => ({
      workerHandle: { pid: 1001 },
      monitorHandle: { ref: "monitor-1" },
    }),
    now: overrides?.now ?? (() => new Date("2026-03-06T00:00:05.000Z")),
  };

  if (overrides?.stopRunningIssue !== undefined) {
    options.stopRunningIssue = overrides.stopRunningIssue;
  }

  if (overrides?.timerScheduler !== undefined) {
    options.timerScheduler = overrides.timerScheduler;
  }

  return new OrchestratorCore(options);
}

function createTracker(input?: {
  candidates?: Issue[];
  statesById?: IssueStateSnapshot[];
}): IssueTracker {
  return {
    async fetchCandidateIssues() {
      return (
        input?.candidates ?? [createIssue({ id: "1", identifier: "ISSUE-1" })]
      );
    },
    async fetchIssuesByStates() {
      return [];
    },
    async fetchIssueStatesByIds() {
      return input?.statesById ?? [];
    },
  };
}

function createConfig(overrides?: {
  agent?: Partial<ResolvedWorkflowConfig["agent"]>;
  codex?: Partial<ResolvedWorkflowConfig["codex"]>;
}): ResolvedWorkflowConfig {
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
      ...overrides?.agent,
    },
    codex: {
      command: "codex-app-server",
      approvalPolicy: "never",
      threadSandbox: null,
      turnSandboxPolicy: null,
      turnTimeoutMs: 300_000,
      readTimeoutMs: 30_000,
      stallTimeoutMs: 300_000,
      ...overrides?.codex,
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

function createIssue(overrides?: Partial<Issue>): Issue {
  return {
    id: overrides?.id ?? "1",
    identifier: overrides?.identifier ?? "ISSUE-1",
    title: overrides?.title ?? "Example issue",
    description: overrides?.description ?? null,
    priority: overrides?.priority ?? 1,
    state: overrides?.state ?? "In Progress",
    branchName: overrides?.branchName ?? null,
    url: overrides?.url ?? null,
    labels: overrides?.labels ?? [],
    blockedBy: overrides?.blockedBy ?? [],
    createdAt: overrides?.createdAt ?? "2026-03-01T00:00:00.000Z",
    updatedAt: overrides?.updatedAt ?? "2026-03-01T00:00:00.000Z",
  };
}

function createFakeTimerScheduler() {
  const scheduled: Array<{
    callback: () => void;
    delayMs: number;
  }> = [];
  return {
    scheduled,
    set(callback: () => void, delayMs: number) {
      scheduled.push({ callback, delayMs });
      return { callback, delayMs } as unknown as ReturnType<typeof setTimeout>;
    },
    clear() {},
  };
}

function createIntegrationHarness(input?: {
  config?: ResolvedWorkflowConfig;
  now?: string;
  candidates?: Issue[];
  statesById?: IssueStateSnapshot[];
}) {
  const trackerState = {
    candidates: input?.candidates ?? [
      createIssue({ id: "1", identifier: "ISSUE-1" }),
    ],
    statesById: input?.statesById ?? [
      { id: "1", identifier: "ISSUE-1", state: "In Progress" },
    ],
  };
  const spawnCalls: Array<{
    issueId: string;
    issueIdentifier: string;
    attempt: number | null;
  }> = [];
  const stopCalls: Array<{
    issueId: string;
    issueIdentifier: string;
    cleanupWorkspace: boolean;
    reason: string;
  }> = [];

  const tracker: IssueTracker = {
    async fetchCandidateIssues() {
      return trackerState.candidates.map((issue) => ({ ...issue }));
    },
    async fetchIssuesByStates() {
      return [];
    },
    async fetchIssueStatesByIds(issueIds) {
      return trackerState.statesById
        .filter((snapshot) => issueIds.includes(snapshot.id))
        .map((snapshot) => ({ ...snapshot }));
    },
  };

  const orchestrator = new OrchestratorCore({
    config: input?.config ?? createConfig(),
    tracker,
    now: () => new Date(input?.now ?? "2026-03-06T00:00:05.000Z"),
    spawnWorker: async ({ issue, attempt }) => {
      spawnCalls.push({
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        attempt,
      });
      return {
        workerHandle: { issueId: issue.id, attempt },
        monitorHandle: { issueId: issue.id, attempt },
      };
    },
    stopRunningIssue: async (stopRequest) => {
      stopCalls.push({
        issueId: stopRequest.issueId,
        issueIdentifier: stopRequest.runningEntry.identifier,
        cleanupWorkspace: stopRequest.cleanupWorkspace,
        reason: stopRequest.reason,
      });
    },
  });

  return {
    orchestrator,
    spawnCalls,
    stopCalls,
    setCandidates(candidates: Issue[]) {
      trackerState.candidates = candidates;
    },
    setStateSnapshots(statesById: IssueStateSnapshot[]) {
      trackerState.statesById = statesById;
    },
  };
}
