import { describe, expect, it } from "vitest";

import type { ResolvedWorkflowConfig } from "../../src/config/types.js";
import type { Issue } from "../../src/domain/model.js";
import {
  OrchestratorCore,
  type OrchestratorCoreOptions,
  classifyExitOutcome,
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

  it("rejects non-Todo issues with non-terminal blockers", () => {
    const orchestrator = createOrchestrator();

    expect(
      orchestrator.isDispatchEligible(
        createIssue({
          id: "ip-1",
          identifier: "ISSUE-IP-1",
          state: "In Progress",
          blockedBy: [{ id: "b1", identifier: "B-1", state: "In Progress" }],
        }),
      ),
    ).toBe(false);

    expect(
      orchestrator.isDispatchEligible(
        createIssue({
          id: "ip-2",
          identifier: "ISSUE-IP-2",
          state: "In Progress",
          blockedBy: [{ id: "b2", identifier: "B-2", state: "Done" }],
        }),
      ),
    ).toBe(true);
  });

  it("rejects Resume-state issues with non-terminal blockers", () => {
    // Resume is an active state in some configurations — blockedBy check must
    // apply to it just like Todo and In Progress (SYMPH-50).
    const config = createConfig();
    config.tracker.activeStates = [
      "Todo",
      "In Progress",
      "In Review",
      "Resume",
    ];
    const orchestrator = createOrchestrator({ config });

    // Blocked by a non-terminal issue → must NOT dispatch
    expect(
      orchestrator.isDispatchEligible(
        createIssue({
          id: "resume-1",
          identifier: "ISSUE-RESUME-1",
          state: "Resume",
          blockedBy: [{ id: "b1", identifier: "B-1", state: "In Progress" }],
        }),
      ),
    ).toBe(false);

    // Blocked by a terminal issue → may dispatch
    expect(
      orchestrator.isDispatchEligible(
        createIssue({
          id: "resume-2",
          identifier: "ISSUE-RESUME-2",
          state: "Resume",
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
      delayType: "failure",
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

  it("skips all dispatch when an open pipeline-halt issue exists", async () => {
    const haltIssue = createIssue({
      id: "halt-1",
      identifier: "SYMPH-123",
      title: "Main branch build broken",
      state: "In Progress",
      labels: ["pipeline-halt"],
    });

    const regularIssues = [
      createIssue({ id: "1", identifier: "ISSUE-1", state: "Todo" }),
      createIssue({ id: "2", identifier: "ISSUE-2", state: "Todo" }),
    ];

    const tracker: IssueTracker = {
      async fetchCandidateIssues() {
        return regularIssues;
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [];
      },
      async fetchIssuesByLabels(labelNames: string[]) {
        if (labelNames.includes("pipeline-halt")) {
          return [haltIssue];
        }
        return [];
      },
    };

    const orchestrator = createOrchestrator({ tracker });
    const result = await orchestrator.pollTick();

    expect(result.validation.ok).toBe(true);
    expect(result.dispatchedIssueIds).toEqual([]);
    expect(Object.keys(orchestrator.getState().running)).toEqual([]);
  });

  it("dispatches normally when no pipeline-halt issue exists", async () => {
    const regularIssues = [
      createIssue({ id: "1", identifier: "ISSUE-1", state: "Todo" }),
      createIssue({ id: "2", identifier: "ISSUE-2", state: "Todo" }),
    ];

    const tracker: IssueTracker = {
      async fetchCandidateIssues() {
        return regularIssues;
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [];
      },
      async fetchIssuesByLabels() {
        return [];
      },
    };

    const orchestrator = createOrchestrator({ tracker });
    const result = await orchestrator.pollTick();

    expect(result.validation.ok).toBe(true);
    expect(result.dispatchedIssueIds).toEqual(["1", "2"]);
    expect(Object.keys(orchestrator.getState().running)).toEqual(["1", "2"]);
  });

  it("dispatches normally when pipeline-halt issue is in terminal state", async () => {
    const closedHaltIssue = createIssue({
      id: "halt-1",
      identifier: "SYMPH-123",
      title: "Main branch build broken",
      state: "Done",
      labels: ["pipeline-halt"],
    });

    const regularIssues = [
      createIssue({ id: "1", identifier: "ISSUE-1", state: "Todo" }),
      createIssue({ id: "2", identifier: "ISSUE-2", state: "Todo" }),
    ];

    const tracker: IssueTracker = {
      async fetchCandidateIssues() {
        return regularIssues;
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [];
      },
      async fetchIssuesByLabels(labelNames: string[]) {
        if (labelNames.includes("pipeline-halt")) {
          return [closedHaltIssue];
        }
        return [];
      },
    };

    const orchestrator = createOrchestrator({ tracker });
    const result = await orchestrator.pollTick();

    expect(result.validation.ok).toBe(true);
    expect(result.dispatchedIssueIds).toEqual(["1", "2"]);
    expect(Object.keys(orchestrator.getState().running)).toEqual(["1", "2"]);
  });

  it("continues dispatch when fetchIssuesByLabels throws an error", async () => {
    const regularIssues = [
      createIssue({ id: "1", identifier: "ISSUE-1", state: "Todo" }),
      createIssue({ id: "2", identifier: "ISSUE-2", state: "Todo" }),
    ];

    const tracker: IssueTracker = {
      async fetchCandidateIssues() {
        return regularIssues;
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [];
      },
      async fetchIssuesByLabels() {
        throw new Error("Linear API error");
      },
    };

    const orchestrator = createOrchestrator({ tracker });
    const result = await orchestrator.pollTick();

    expect(result.validation.ok).toBe(true);
    expect(result.dispatchedIssueIds).toEqual(["1", "2"]);
    expect(Object.keys(orchestrator.getState().running)).toEqual(["1", "2"]);
  });

  it("dispatches normally when tracker does not implement fetchIssuesByLabels", async () => {
    const regularIssues = [
      createIssue({ id: "1", identifier: "ISSUE-1", state: "Todo" }),
      createIssue({ id: "2", identifier: "ISSUE-2", state: "Todo" }),
    ];

    const tracker: IssueTracker = {
      async fetchCandidateIssues() {
        return regularIssues;
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [];
      },
      // Note: fetchIssuesByLabels is not implemented (optional)
    };

    const orchestrator = createOrchestrator({ tracker });
    const result = await orchestrator.pollTick();

    expect(result.validation.ok).toBe(true);
    expect(result.dispatchedIssueIds).toEqual(["1", "2"]);
    expect(Object.keys(orchestrator.getState().running)).toEqual(["1", "2"]);
  });
  it("uses fetchOpenIssuesByLabels for halt check when available (P2: server-side filtering)", async () => {
    let openIssuesByLabelsCalled = false;
    let issuesByLabelsCalled = false;

    const regularIssues = [
      createIssue({ id: "1", identifier: "ISSUE-1", state: "Todo" }),
    ];

    const tracker: IssueTracker = {
      async fetchCandidateIssues() {
        return regularIssues;
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [];
      },
      async fetchIssuesByLabels() {
        issuesByLabelsCalled = true;
        return [];
      },
      async fetchOpenIssuesByLabels() {
        openIssuesByLabelsCalled = true;
        return [];
      },
    };

    const orchestrator = createOrchestrator({ tracker });
    await orchestrator.pollTick();

    expect(openIssuesByLabelsCalled).toBe(true);
    expect(issuesByLabelsCalled).toBe(false);
  });

  it("falls back to fetchIssuesByLabels when fetchOpenIssuesByLabels throws", async () => {
    const haltIssue = createIssue({
      id: "halt-1",
      identifier: "SYMPH-123",
      title: "Main branch build broken",
      state: "In Progress",
      labels: ["pipeline-halt"],
    });

    const regularIssues = [
      createIssue({ id: "1", identifier: "ISSUE-1", state: "Todo" }),
    ];

    const tracker: IssueTracker = {
      async fetchCandidateIssues() {
        return regularIssues;
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [];
      },
      async fetchIssuesByLabels(labelNames: string[]) {
        if (labelNames.includes("pipeline-halt")) {
          return [haltIssue];
        }
        return [];
      },
      async fetchOpenIssuesByLabels() {
        throw new Error("Linear API timeout");
      },
    };

    const orchestrator = createOrchestrator({ tracker });
    const result = await orchestrator.pollTick();

    // Should halt dispatch because the fallback found the halt issue
    expect(result.dispatchedIssueIds).toEqual([]);
    expect(Object.keys(orchestrator.getState().running)).toEqual([]);
  });
});

describe("retry timer pipeline-halt guard", () => {
  it("skips dispatch and requeues retry at same attempt when pipeline is halted", async () => {
    const haltIssue = createIssue({
      id: "halt-1",
      identifier: "SYMPH-99",
      title: "CI broken",
      state: "In Progress",
      labels: ["pipeline-halt"],
    });

    const timers = createFakeTimerScheduler();
    const tracker: IssueTracker = {
      async fetchCandidateIssues() {
        return [createIssue({ id: "1", identifier: "ISSUE-1" })];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [];
      },
      async fetchOpenIssuesByLabels(labelNames: string[]) {
        if (labelNames.includes("pipeline-halt")) {
          return [haltIssue];
        }
        return [];
      },
    };

    const spawnCalls: string[] = [];
    const orchestrator = new OrchestratorCore({
      config: createConfig(),
      tracker,
      spawnWorker: async ({ issue }) => {
        spawnCalls.push(issue.id);
        return {
          workerHandle: { pid: 1001 },
          monitorHandle: { ref: "monitor-1" },
        };
      },
      timerScheduler: timers,
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    // Manually set up a retry entry at attempt 2
    orchestrator.getState().claimed.add("1");
    orchestrator.getState().retryAttempts["1"] = {
      issueId: "1",
      identifier: "ISSUE-1",
      attempt: 2,
      dueAtMs: Date.parse("2026-03-06T00:00:00.000Z"),
      timerHandle: null,
      error: "previous failure",
      delayType: "failure",
    };

    const result = await orchestrator.onRetryTimer("1");

    // Should NOT dispatch
    expect(result.dispatched).toBe(false);
    expect(result.released).toBe(false);
    expect(spawnCalls).toEqual([]);

    // Should requeue at the SAME attempt (2), not increment to 3
    expect(result.retryEntry).not.toBeNull();
    expect(result.retryEntry).toMatchObject({
      issueId: "1",
      attempt: 2,
      identifier: "ISSUE-1",
      error: "pipeline halted: SYMPH-99",
      delayType: "failure",
    });

    // Claim should still be held
    expect(orchestrator.getState().claimed.has("1")).toBe(true);
  });

  it("dispatches normally when halt check returns no open issues", async () => {
    const timers = createFakeTimerScheduler();
    const tracker: IssueTracker = {
      async fetchCandidateIssues() {
        return [createIssue({ id: "1", identifier: "ISSUE-1" })];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }];
      },
      async fetchOpenIssuesByLabels() {
        return [];
      },
    };

    const spawnCalls: string[] = [];
    const orchestrator = new OrchestratorCore({
      config: createConfig(),
      tracker,
      spawnWorker: async ({ issue }) => {
        spawnCalls.push(issue.id);
        return {
          workerHandle: { pid: 1001 },
          monitorHandle: { ref: "monitor-1" },
        };
      },
      timerScheduler: timers,
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    // Set up a retry entry
    orchestrator.getState().claimed.add("1");
    orchestrator.getState().retryAttempts["1"] = {
      issueId: "1",
      identifier: "ISSUE-1",
      attempt: 1,
      dueAtMs: Date.parse("2026-03-06T00:00:00.000Z"),
      timerHandle: null,
      error: "previous failure",
      delayType: "failure",
    };

    const result = await orchestrator.onRetryTimer("1");

    expect(result.dispatched).toBe(true);
    expect(result.released).toBe(false);
    expect(spawnCalls).toEqual(["1"]);
  });

  it("continues dispatch when halt check throws (fail-open)", async () => {
    const timers = createFakeTimerScheduler();
    const tracker: IssueTracker = {
      async fetchCandidateIssues() {
        return [createIssue({ id: "1", identifier: "ISSUE-1" })];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }];
      },
      async fetchOpenIssuesByLabels() {
        throw new Error("Linear API timeout");
      },
    };

    const spawnCalls: string[] = [];
    const orchestrator = new OrchestratorCore({
      config: createConfig(),
      tracker,
      spawnWorker: async ({ issue }) => {
        spawnCalls.push(issue.id);
        return {
          workerHandle: { pid: 1001 },
          monitorHandle: { ref: "monitor-1" },
        };
      },
      timerScheduler: timers,
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    // Set up a retry entry
    orchestrator.getState().claimed.add("1");
    orchestrator.getState().retryAttempts["1"] = {
      issueId: "1",
      identifier: "ISSUE-1",
      attempt: 1,
      dueAtMs: Date.parse("2026-03-06T00:00:00.000Z"),
      timerHandle: null,
      error: "previous failure",
      delayType: "failure",
    };

    const result = await orchestrator.onRetryTimer("1");

    // Should proceed with dispatch despite halt check failure
    expect(result.dispatched).toBe(true);
    expect(spawnCalls).toEqual(["1"]);
  });

  it("falls back to fetchIssuesByLabels when fetchOpenIssuesByLabels throws", async () => {
    const haltIssue = createIssue({
      id: "halt-1",
      identifier: "SYMPH-99",
      title: "CI broken",
      state: "In Progress",
      labels: ["pipeline-halt"],
    });

    const timers = createFakeTimerScheduler();
    const tracker: IssueTracker = {
      async fetchCandidateIssues() {
        return [createIssue({ id: "1", identifier: "ISSUE-1" })];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [];
      },
      async fetchIssuesByLabels(labelNames: string[]) {
        if (labelNames.includes("pipeline-halt")) {
          return [haltIssue];
        }
        return [];
      },
      async fetchOpenIssuesByLabels() {
        throw new Error("Linear API timeout");
      },
    };

    const spawnCalls: string[] = [];
    const orchestrator = new OrchestratorCore({
      config: createConfig(),
      tracker,
      spawnWorker: async ({ issue }) => {
        spawnCalls.push(issue.id);
        return {
          workerHandle: { pid: 1001 },
          monitorHandle: { ref: "monitor-1" },
        };
      },
      timerScheduler: timers,
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    orchestrator.getState().claimed.add("1");
    orchestrator.getState().retryAttempts["1"] = {
      issueId: "1",
      identifier: "ISSUE-1",
      attempt: 2,
      dueAtMs: Date.parse("2026-03-06T00:00:00.000Z"),
      timerHandle: null,
      error: "previous failure",
      delayType: "failure",
    };

    const result = await orchestrator.onRetryTimer("1");

    // Should halt because fallback found the halt issue
    expect(result.dispatched).toBe(false);
    expect(result.retryEntry).toMatchObject({
      attempt: 2,
      error: "pipeline halted: SYMPH-99",
    });
    expect(spawnCalls).toEqual([]);
  });

  it("falls back to fetchIssuesByLabels when fetchOpenIssuesByLabels is not available", async () => {
    const haltIssue = createIssue({
      id: "halt-1",
      identifier: "SYMPH-99",
      title: "CI broken",
      state: "In Progress",
      labels: ["pipeline-halt"],
    });

    const timers = createFakeTimerScheduler();
    const tracker: IssueTracker = {
      async fetchCandidateIssues() {
        return [createIssue({ id: "1", identifier: "ISSUE-1" })];
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [];
      },
      // Only fetchIssuesByLabels, no fetchOpenIssuesByLabels
      async fetchIssuesByLabels(labelNames: string[]) {
        if (labelNames.includes("pipeline-halt")) {
          return [haltIssue];
        }
        return [];
      },
    };

    const spawnCalls: string[] = [];
    const orchestrator = new OrchestratorCore({
      config: createConfig(),
      tracker,
      spawnWorker: async ({ issue }) => {
        spawnCalls.push(issue.id);
        return {
          workerHandle: { pid: 1001 },
          monitorHandle: { ref: "monitor-1" },
        };
      },
      timerScheduler: timers,
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    orchestrator.getState().claimed.add("1");
    orchestrator.getState().retryAttempts["1"] = {
      issueId: "1",
      identifier: "ISSUE-1",
      attempt: 2,
      dueAtMs: Date.parse("2026-03-06T00:00:00.000Z"),
      timerHandle: null,
      error: "previous failure",
      delayType: "failure",
    };

    const result = await orchestrator.onRetryTimer("1");

    expect(result.dispatched).toBe(false);
    expect(result.retryEntry).toMatchObject({
      attempt: 2,
      error: "pipeline halted: SYMPH-99",
    });
    expect(spawnCalls).toEqual([]);
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
    expect(orchestrator.getState().failed.has("1")).toBe(true);
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
      delayType: "failure",
    };

    // When onRetryTimer fires and slots are exhausted, it calls scheduleRetry
    // with attempt 3, which exceeds maxRetryAttempts=2
    const result = await orchestrator.onRetryTimer("1");

    expect(result.dispatched).toBe(false);
    expect(result.retryEntry).toBeNull();
    expect(orchestrator.getState().failed.has("1")).toBe(true);
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
    // After the fix for SYMPH-126, continuations no longer add to completed —
    // only terminal completions do.
    expect(orchestrator.getState().completed.has("1")).toBe(false);
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
    expect(orchestrator.getState().failed.has("1")).toBe(true);
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
    expect(orchestrator.getState().failed.has("1")).toBe(true);
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
      fastTrack: null,
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
      fastTrack: null,
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

describe("execution history stage records", () => {
  function createStageConfig() {
    const config = createConfig();
    config.stages = {
      initialStage: "investigate",
      fastTrack: null,
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
            onComplete: "implement",
            onApprove: null,
            onRework: null,
          },
          linearState: null,
        },
        implement: {
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
          transitions: { onComplete: null, onApprove: null, onRework: null },
          linearState: null,
        },
      },
    };
    return config;
  }

  it("stage record appended on worker exit", async () => {
    const config = createStageConfig();
    const orchestrator = createOrchestrator({ config });

    await orchestrator.pollTick();
    // Set the issue to the investigate stage
    orchestrator.getState().issueStages["1"] = "investigate";

    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      endedAt: new Date("2026-03-06T00:00:10.000Z"),
    });

    const history = orchestrator.getState().issueExecutionHistory["1"];
    expect(history).toBeDefined();
    expect(history).toHaveLength(1);
  });

  it("stage record captures all fields", async () => {
    const config = createStageConfig();
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();
    orchestrator.getState().issueStages["1"] = "investigate";

    // Apply codex event to give the running entry some token/turn data
    orchestrator.onCodexEvent({
      issueId: "1",
      event: {
        event: "turn_completed",
        timestamp: "2026-03-06T00:00:06.000Z",
        codexAppServerPid: "1001",
        sessionId: "s1",
        threadId: "t1",
        turnId: "turn-1",
        usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
        rateLimits: {},
        message: "done",
      },
    });

    const startedAt = orchestrator.getState().running["1"]?.startedAt;
    expect(startedAt).toBeDefined();

    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      endedAt: new Date("2026-03-06T00:01:05.000Z"),
    });

    const history = orchestrator.getState().issueExecutionHistory["1"];
    expect(history).toBeDefined();
    expect(history).toHaveLength(1);
    const record = history![0]!;
    expect(record.stageName).toBe("investigate");
    expect(record.durationMs).toBe(60_000);
    expect(record.totalTokens).toBeGreaterThanOrEqual(0);
    expect(typeof record.turns).toBe("number");
    expect(record.outcome).toBe("normal");
  });

  it("StageRecord captures per-type tokens on stage completion", async () => {
    const config = createStageConfig();
    const orchestrator = createOrchestrator({
      config,
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();
    orchestrator.getState().issueStages["1"] = "investigate";

    // Simulate turn_completed with 3000 input and 2000 output tokens
    orchestrator.onCodexEvent({
      issueId: "1",
      event: {
        event: "turn_completed",
        timestamp: "2026-03-06T00:00:06.000Z",
        codexAppServerPid: "1001",
        sessionId: "s1",
        threadId: "t1",
        turnId: "turn-1",
        usage: { inputTokens: 3000, outputTokens: 2000, totalTokens: 5000 },
        rateLimits: {},
        message: "done",
      },
    });

    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      endedAt: new Date("2026-03-06T00:01:05.000Z"),
    });

    const history = orchestrator.getState().issueExecutionHistory["1"];
    expect(history).toBeDefined();
    expect(history).toHaveLength(1);
    const record = history![0]!;
    expect(record.stageName).toBe("investigate");
    expect(record.inputTokens).toBe(3000);
    expect(record.outputTokens).toBe(2000);
    expect(record.totalTokens).toBe(5000);
  });

  it("accumulates records across multiple stages", async () => {
    const config = createStageConfig();
    const orchestrator = createOrchestrator({ config });

    // First stage: investigate
    await orchestrator.pollTick();
    orchestrator.getState().issueStages["1"] = "investigate";

    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      endedAt: new Date("2026-03-06T00:01:00.000Z"),
    });

    // After normal exit, stage advances to "implement"
    // issueExecutionHistory should have 1 record for "investigate"
    const historyAfterFirst =
      orchestrator.getState().issueExecutionHistory["1"];
    expect(historyAfterFirst).toHaveLength(1);
    expect(historyAfterFirst![0]!.stageName).toBe("investigate");

    // Second stage: implement
    await orchestrator.onRetryTimer("1");
    orchestrator.getState().issueStages["1"] = "implement";

    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      endedAt: new Date("2026-03-06T00:02:00.000Z"),
    });

    // issueExecutionHistory should have 2 records
    const historyAfterSecond =
      orchestrator.getState().issueExecutionHistory["1"];
    expect(historyAfterSecond).toHaveLength(2);
    expect(historyAfterSecond![1]!.stageName).toBe("implement");
    expect(historyAfterSecond![1]!.outcome).toBe("failed_to_start");
  });

  it("does not append a stage record when no stage is set for the issue", async () => {
    const orchestrator = createOrchestrator();

    await orchestrator.pollTick();
    // No issueStages entry — no stage configured

    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      endedAt: new Date("2026-03-06T00:01:00.000Z"),
    });

    // issueExecutionHistory should have no entry for this issue
    expect(orchestrator.getState().issueExecutionHistory["1"]).toBeUndefined();
  });
});

describe("execution report on terminal state", () => {
  function createTerminalStageConfig() {
    const config = createConfig();
    config.stages = {
      initialStage: "investigate",
      fastTrack: null,
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
            onComplete: "merge",
            onApprove: null,
            onRework: null,
          },
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
          transitions: {
            onComplete: "done",
            onApprove: null,
            onRework: null,
          },
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
    return config;
  }

  it("posts execution report on terminal state", async () => {
    const postedComments: Array<{ issueId: string; body: string }> = [];
    const config = createTerminalStageConfig();
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      postComment: async (issueId, body) => {
        postedComments.push({ issueId, body });
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();
    orchestrator.getState().issueStages["1"] = "merge";

    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      endedAt: new Date("2026-03-06T00:01:05.000Z"),
    });

    // Allow microtasks (void promise) to flush
    await Promise.resolve();

    expect(postedComments).toHaveLength(1);
    expect(postedComments[0]?.body).toMatch(/^## Execution Report/);
  });

  it("execution report contains stage timeline", async () => {
    const postedComments: Array<{ issueId: string; body: string }> = [];
    const config = createTerminalStageConfig();
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      postComment: async (issueId, body) => {
        postedComments.push({ issueId, body });
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();
    // Manually inject history for investigate and merge stages
    orchestrator.getState().issueExecutionHistory["1"] = [
      {
        stageName: "investigate",
        durationMs: 18_000,
        totalTokens: 50_000,
        turns: 5,
        outcome: "normal",
      },
    ];
    orchestrator.getState().issueStages["1"] = "merge";

    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      endedAt: new Date("2026-03-06T00:01:05.000Z"),
    });

    await Promise.resolve();

    expect(postedComments).toHaveLength(1);
    const body = postedComments[0]!.body;
    // Table columns
    expect(body).toContain("| Stage |");
    expect(body).toContain("| Duration |");
    expect(body).toContain("| Tokens |");
    expect(body).toContain("| Turns |");
    expect(body).toContain("| Outcome |");
    // Stage rows
    expect(body).toContain("investigate");
    expect(body).toContain("merge");
  });

  it("execution report contains total tokens", async () => {
    const postedComments: Array<{ issueId: string; body: string }> = [];
    const config = createTerminalStageConfig();
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      postComment: async (issueId, body) => {
        postedComments.push({ issueId, body });
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();
    orchestrator.getState().issueExecutionHistory["1"] = [
      {
        stageName: "investigate",
        durationMs: 18_000,
        totalTokens: 50_000,
        turns: 5,
        outcome: "normal",
      },
      {
        stageName: "implement",
        durationMs: 120_000,
        totalTokens: 200_000,
        turns: 10,
        outcome: "normal",
      },
      {
        stageName: "review",
        durationMs: 45_000,
        totalTokens: 80_000,
        turns: 3,
        outcome: "normal",
      },
    ];
    orchestrator.getState().issueStages["1"] = "merge";

    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      endedAt: new Date("2026-03-06T00:01:05.000Z"),
    });

    await Promise.resolve();

    expect(postedComments).toHaveLength(1);
    const body = postedComments[0]!.body;
    expect(body).toContain("Total tokens");
    // 50000 + 200000 + 80000 = 330000, plus merge stage tokens (0 in this test)
    // The merge stage exit adds its record too
    expect(body).toMatch(/Total tokens.*\d/);
  });

  it("execution report shows rework count", async () => {
    const postedComments: Array<{ issueId: string; body: string }> = [];
    const config = createTerminalStageConfig();
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      postComment: async (issueId, body) => {
        postedComments.push({ issueId, body });
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();
    orchestrator.getState().issueStages["1"] = "merge";
    orchestrator.getState().issueReworkCounts["1"] = 1;

    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      endedAt: new Date("2026-03-06T00:01:05.000Z"),
    });

    await Promise.resolve();

    expect(postedComments).toHaveLength(1);
    const body = postedComments[0]!.body;
    expect(body).toContain("Rework count");
    expect(body).toContain("1");
  });

  it("execution report includes rework stages", async () => {
    const postedComments: Array<{ issueId: string; body: string }> = [];
    const config = createTerminalStageConfig();
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      postComment: async (issueId, body) => {
        postedComments.push({ issueId, body });
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();
    // Simulate: investigate, implement, review (fail), implement (rework), review (pass)
    orchestrator.getState().issueExecutionHistory["1"] = [
      {
        stageName: "investigate",
        durationMs: 10_000,
        totalTokens: 10_000,
        turns: 3,
        outcome: "normal",
      },
      {
        stageName: "implement",
        durationMs: 60_000,
        totalTokens: 80_000,
        turns: 8,
        outcome: "normal",
      },
      {
        stageName: "review",
        durationMs: 20_000,
        totalTokens: 30_000,
        turns: 2,
        outcome: "normal",
      },
      {
        stageName: "implement",
        durationMs: 50_000,
        totalTokens: 70_000,
        turns: 7,
        outcome: "normal",
      },
      {
        stageName: "review",
        durationMs: 25_000,
        totalTokens: 35_000,
        turns: 2,
        outcome: "normal",
      },
    ];
    orchestrator.getState().issueStages["1"] = "merge";
    orchestrator.getState().issueReworkCounts["1"] = 1;

    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      endedAt: new Date("2026-03-06T00:01:05.000Z"),
    });

    await Promise.resolve();

    expect(postedComments).toHaveLength(1);
    const body = postedComments[0]!.body;
    // 5 pre-existing records + 1 merge record = 6 total stage rows
    const tableRows = body
      .split("\n")
      .filter(
        (line) =>
          line.startsWith("| ") &&
          !line.startsWith("| Stage") &&
          !line.startsWith("|----"),
      );
    expect(tableRows).toHaveLength(6);
  });

  it("execution report failure does not block terminal transition", async () => {
    const config = createTerminalStageConfig();
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      postComment: async (_issueId, _body) => {
        throw new Error("postComment failed");
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();
    orchestrator.getState().issueStages["1"] = "merge";

    const retryEntry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      endedAt: new Date("2026-03-06T00:01:05.000Z"),
    });

    // Terminal transition: returns null (no retry), issue is completed
    expect(retryEntry).toBeNull();
    expect(orchestrator.getState().completed.has("1")).toBe(true);
  });

  it("history cleaned up even if report posting fails", async () => {
    const config = createTerminalStageConfig();
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      postComment: async (_issueId, _body) => {
        throw new Error("postComment failed");
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();
    orchestrator.getState().issueStages["1"] = "merge";
    orchestrator.getState().issueExecutionHistory["1"] = [
      {
        stageName: "investigate",
        durationMs: 10_000,
        totalTokens: 10_000,
        turns: 3,
        outcome: "normal",
      },
    ];

    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      endedAt: new Date("2026-03-06T00:01:05.000Z"),
    });

    // State should be cleaned up regardless of postComment failure
    expect(orchestrator.getState().issueStages["1"]).toBeUndefined();
    expect(orchestrator.getState().issueReworkCounts["1"]).toBeUndefined();
    // History may contain the merge record from onWorkerExit, but after advanceStage it's deleted
    expect(orchestrator.getState().issueExecutionHistory["1"]).toBeUndefined();
  });

  it("no execution report without postComment", async () => {
    // No postComment configured — just verify it completes normally without error
    const config = createTerminalStageConfig();
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      // postComment intentionally not configured
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();
    orchestrator.getState().issueStages["1"] = "merge";

    const retryEntry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      endedAt: new Date("2026-03-06T00:01:05.000Z"),
    });

    // Issue completes normally
    expect(retryEntry).toBeNull();
    expect(orchestrator.getState().completed.has("1")).toBe(true);
    // No side effects
    expect(orchestrator.getState().issueStages["1"]).toBeUndefined();
  });

  it("execution history cleaned up after completion", async () => {
    const postedComments: Array<{ issueId: string; body: string }> = [];
    const config = createTerminalStageConfig();
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      postComment: async (issueId, body) => {
        postedComments.push({ issueId, body });
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();
    // Pre-populate execution history with 4 stages
    orchestrator.getState().issueExecutionHistory["1"] = [
      {
        stageName: "investigate",
        durationMs: 18_000,
        totalTokens: 50_000,
        turns: 5,
        outcome: "normal",
      },
      {
        stageName: "implement",
        durationMs: 120_000,
        totalTokens: 200_000,
        turns: 10,
        outcome: "normal",
      },
      {
        stageName: "review",
        durationMs: 45_000,
        totalTokens: 80_000,
        turns: 3,
        outcome: "normal",
      },
    ];
    orchestrator.getState().issueStages["1"] = "merge";

    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      endedAt: new Date("2026-03-06T00:01:05.000Z"),
    });

    // Allow microtasks (void promise) to flush
    await Promise.resolve();

    // Execution history must be deleted from orchestrator state after Done
    expect(orchestrator.getState().issueExecutionHistory["1"]).toBeUndefined();
    // Stages and rework counts also cleaned up
    expect(orchestrator.getState().issueStages["1"]).toBeUndefined();
    expect(orchestrator.getState().issueReworkCounts["1"]).toBeUndefined();
    // Issue is marked completed
    expect(orchestrator.getState().completed.has("1")).toBe(true);
    // Report was still posted before cleanup
    expect(postedComments).toHaveLength(1);
  });
});

describe("review findings comment on agent review failure", () => {
  /**
   * Build a stage config with:
   *   implement (agent) → review (agent, onRework: implement, maxRework: N) → done (terminal)
   */
  function createReviewStageConfig(maxRework = 2) {
    const config = createConfig();
    config.escalationState = "Blocked";
    config.tracker.activeStates = [
      "Todo",
      "In Progress",
      "In Review",
      "Blocked",
    ];
    config.stages = {
      initialStage: "implement",
      fastTrack: null,
      stages: {
        implement: {
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
            onComplete: "review",
            onApprove: null,
            onRework: null,
          },
          linearState: null,
        },
        review: {
          type: "agent",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework,
          reviewers: [],
          transitions: {
            onComplete: "done",
            onApprove: null,
            onRework: "implement",
          },
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
    return config;
  }

  it("posts review findings comment on agent review failure", async () => {
    const postedComments: Array<{ issueId: string; body: string }> = [];
    const config = createReviewStageConfig();
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      postComment: async (issueId, body) => {
        postedComments.push({ issueId, body });
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();
    orchestrator.getState().issueStages["1"] = "review";

    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage:
        "[STAGE_FAILED: review] Missing null check in handler.ts line 42",
    });

    // Flush microtasks so the void promise resolves
    await Promise.resolve();

    const reviewComment = postedComments.find((c) =>
      c.body.startsWith("## Review Findings"),
    );
    expect(reviewComment).toBeDefined();
    expect(reviewComment?.issueId).toBe("1");
  });

  it("review findings comment includes agent message", async () => {
    const postedComments: Array<{ issueId: string; body: string }> = [];
    const config = createReviewStageConfig();
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      postComment: async (issueId, body) => {
        postedComments.push({ issueId, body });
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();
    orchestrator.getState().issueStages["1"] = "review";

    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage:
        "[STAGE_FAILED: review] Missing null check in handler.ts line 42",
    });

    await Promise.resolve();

    const reviewComment = postedComments.find((c) =>
      c.body.startsWith("## Review Findings"),
    );
    expect(reviewComment?.body).toContain(
      "Missing null check in handler.ts line 42",
    );
  });

  it("review failure triggers rework after posting comment", async () => {
    const config = createReviewStageConfig();
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();
    orchestrator.getState().issueStages["1"] = "review";

    const retryEntry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage:
        "[STAGE_FAILED: review] Missing null check in handler.ts line 42",
    });

    // Should schedule a rework retry (continuation, not failure)
    expect(retryEntry).not.toBeNull();
    expect(retryEntry?.error).toContain("rework to implement");
    // Stage should be updated to the rework target
    expect(orchestrator.getState().issueStages["1"]).toBe("implement");
  });

  it("review findings comment failure does not block rework", async () => {
    const config = createReviewStageConfig();
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      postComment: async (_issueId, _body) => {
        throw new Error("Comment service unavailable");
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();
    orchestrator.getState().issueStages["1"] = "review";

    const retryEntry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: review] Some failure",
    });

    // Rework must proceed despite postComment throwing
    expect(retryEntry).not.toBeNull();
    expect(retryEntry?.error).toContain("rework to implement");
  });

  it("postComment error is swallowed for review findings", async () => {
    const config = createReviewStageConfig();
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      postComment: async (_issueId, _body) => {
        throw new Error("Comment service unavailable");
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();
    orchestrator.getState().issueStages["1"] = "review";

    // Should not throw — error must be swallowed
    let threw = false;
    try {
      orchestrator.onWorkerExit({
        issueId: "1",
        outcome: "normal",
        agentMessage: "[STAGE_FAILED: review] Some failure",
      });
      // Allow microtasks to flush so the void promise rejects internally
      await Promise.resolve();
    } catch {
      threw = true;
    }

    expect(threw).toBe(false);
  });

  it("skips review findings when postComment not configured", async () => {
    const config = createReviewStageConfig();
    // No postComment wired — omit it entirely
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();
    orchestrator.getState().issueStages["1"] = "review";

    const retryEntry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: review] Some failure",
    });

    // Rework still proceeds
    expect(retryEntry).not.toBeNull();
    expect(retryEntry?.error).toContain("rework to implement");
    // No comment was posted (no postComment configured — no crash either)
    expect(orchestrator.getState().issueStages["1"]).toBe("implement");
  });

  it("escalation fires on max rework exceeded", async () => {
    const escalationComments: Array<{ issueId: string; body: string }> = [];
    const stateUpdates: Array<{ issueId: string; state: string }> = [];
    const config = createReviewStageConfig(1); // maxRework=1
    const orchestrator = new OrchestratorCore({
      config,
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
      updateIssueState: async (issueId, _issueIdentifier, stateName) => {
        stateUpdates.push({ issueId, state: stateName });
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();
    orchestrator.getState().issueStages["1"] = "review";
    // Already used 1 rework — next failure should trigger escalation
    orchestrator.getState().issueReworkCounts["1"] = 1;

    const retryEntry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: review] Another null check failure",
    });

    await Promise.resolve();

    // Escalation: issue is failed, no retry
    expect(retryEntry).toBeNull();
    expect(orchestrator.getState().failed.has("1")).toBe(true);

    // Escalation side effects fire
    expect(stateUpdates).toHaveLength(1);
    expect(stateUpdates[0]?.state).toBe("Blocked");
    expect(escalationComments).toHaveLength(1);
    expect(escalationComments[0]?.body).toContain(
      "max rework attempts exceeded",
    );
  });

  it("no review findings on escalation", async () => {
    const postedComments: Array<{ issueId: string; body: string }> = [];
    const config = createReviewStageConfig(1); // maxRework=1
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
        statesById: [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      postComment: async (issueId, body) => {
        postedComments.push({ issueId, body });
      },
      updateIssueState: async (_issueId, _identifier, _state) => {
        // no-op
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();
    orchestrator.getState().issueStages["1"] = "review";
    orchestrator.getState().issueReworkCounts["1"] = 1;

    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: review] Another null check failure",
    });

    await Promise.resolve();

    // Only the escalation comment should have been posted — not a review findings comment
    const reviewFindings = postedComments.filter((c) =>
      c.body.startsWith("## Review Findings"),
    );
    expect(reviewFindings).toHaveLength(0);

    // The escalation comment should be present
    const escalation = postedComments.filter(
      (c) => !c.body.startsWith("## Review Findings"),
    );
    expect(escalation).toHaveLength(1);
    expect(escalation[0]?.body).toContain("max rework attempts exceeded");
  });
});

describe("auto-close parent", () => {
  function createTerminalStageConfig() {
    const config = createConfig();
    config.stages = {
      initialStage: "implement",
      fastTrack: null,
      stages: {
        implement: {
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
            onComplete: "done",
            onApprove: null,
            onRework: null,
          },
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
    return config;
  }

  it("auto-close parent fires on terminal state transition", async () => {
    const autoCloseCalls: Array<{
      issueId: string;
      issueIdentifier: string;
    }> = [];
    const config = createTerminalStageConfig();
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "SYMPH-1" })],
        statesById: [{ id: "1", identifier: "SYMPH-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      autoCloseParentIssue: async (issueId, issueIdentifier) => {
        autoCloseCalls.push({ issueId, issueIdentifier });
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();
    orchestrator.getState().issueStages["1"] = "implement";

    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      endedAt: new Date("2026-03-06T00:01:05.000Z"),
    });

    // Allow microtasks (void promise) to flush
    await Promise.resolve();

    expect(autoCloseCalls).toHaveLength(1);
    expect(autoCloseCalls[0]).toEqual({
      issueId: "1",
      issueIdentifier: "SYMPH-1",
    });
  });

  it("auto-close parent does not fire on non-terminal stage transitions", async () => {
    const autoCloseCalls: Array<{
      issueId: string;
      issueIdentifier: string;
    }> = [];
    const config = createConfig();
    config.stages = {
      initialStage: "implement",
      fastTrack: null,
      stages: {
        implement: {
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
            onComplete: "review",
            onApprove: null,
            onRework: null,
          },
          linearState: null,
        },
        review: {
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
            onComplete: "done",
            onApprove: null,
            onRework: null,
          },
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

    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "SYMPH-1" })],
        statesById: [{ id: "1", identifier: "SYMPH-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      autoCloseParentIssue: async (issueId, issueIdentifier) => {
        autoCloseCalls.push({ issueId, issueIdentifier });
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();
    orchestrator.getState().issueStages["1"] = "implement";

    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      endedAt: new Date("2026-03-06T00:01:05.000Z"),
    });

    // Allow microtasks to flush
    await Promise.resolve();

    // Should not fire — this was a non-terminal transition (implement → review)
    expect(autoCloseCalls).toHaveLength(0);
  });

  it("auto-close parent failure does not block terminal transition", async () => {
    const updateStateCalls: Array<{
      issueId: string;
      stateName: string;
    }> = [];
    const config = createTerminalStageConfig();
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "SYMPH-1" })],
        statesById: [{ id: "1", identifier: "SYMPH-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      updateIssueState: async (issueId, _identifier, stateName) => {
        updateStateCalls.push({ issueId, stateName });
      },
      autoCloseParentIssue: async () => {
        throw new Error("Linear API unreachable");
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();
    orchestrator.getState().issueStages["1"] = "implement";

    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      endedAt: new Date("2026-03-06T00:01:05.000Z"),
    });

    // Allow microtasks to flush
    await Promise.resolve();

    // The terminal state update should still have fired despite autoCloseParentIssue failure
    expect(updateStateCalls).toHaveLength(1);
    expect(updateStateCalls[0]).toEqual({ issueId: "1", stateName: "Done" });

    // Issue should be completed (not blocked by the auto-close failure)
    expect(orchestrator.getState().completed.has("1")).toBe(true);
  });

  it("auto-close parent is not called when callback is not provided", async () => {
    const config = createTerminalStageConfig();
    const orchestrator = new OrchestratorCore({
      config,
      tracker: createTracker({
        candidates: [createIssue({ id: "1", identifier: "SYMPH-1" })],
        statesById: [{ id: "1", identifier: "SYMPH-1", state: "In Progress" }],
      }),
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();
    orchestrator.getState().issueStages["1"] = "implement";

    // Should not throw even without autoCloseParentIssue callback
    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      endedAt: new Date("2026-03-06T00:01:05.000Z"),
    });

    await Promise.resolve();

    expect(orchestrator.getState().completed.has("1")).toBe(true);
  });
});

describe("fast-track label-based stage routing", () => {
  function createFastTrackConfig(
    overrides?: Partial<ResolvedWorkflowConfig>,
  ): ResolvedWorkflowConfig {
    return {
      ...createConfig(),
      stages: {
        initialStage: "investigate",
        fastTrack: { label: "trivial", initialStage: "implement" },
        stages: Object.freeze({
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
              onComplete: "implement",
              onApprove: null,
              onRework: null,
            },
            linearState: null,
          },
          implement: {
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
              onComplete: "done",
              onApprove: null,
              onRework: null,
            },
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
            linearState: null,
          },
        }),
      },
      ...overrides,
    };
  }

  it("fast-track: trivial-labeled issue starts at fast-track initial stage", async () => {
    const spawnedStageNames: Array<string | null> = [];
    const orchestrator = new OrchestratorCore({
      config: createFastTrackConfig(),
      tracker: createTracker({
        candidates: [
          createIssue({
            id: "1",
            identifier: "ISSUE-1",
            state: "Todo",
            labels: ["trivial"],
          }),
        ],
      }),
      spawnWorker: async ({ stageName }) => {
        spawnedStageNames.push(stageName);
        return {
          workerHandle: { pid: 1001 },
          monitorHandle: { ref: "monitor-1" },
        };
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();

    expect(spawnedStageNames).toEqual(["implement"]);
    expect(orchestrator.getState().issueStages["1"]).toBe("implement");
  });

  it("fast-track: non-trivial issue follows normal pipeline (starts at investigate)", async () => {
    const spawnedStageNames: Array<string | null> = [];
    const orchestrator = new OrchestratorCore({
      config: createFastTrackConfig(),
      tracker: createTracker({
        candidates: [
          createIssue({
            id: "1",
            identifier: "ISSUE-1",
            state: "Todo",
            labels: [],
          }),
        ],
      }),
      spawnWorker: async ({ stageName }) => {
        spawnedStageNames.push(stageName);
        return {
          workerHandle: { pid: 1001 },
          monitorHandle: { ref: "monitor-1" },
        };
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();

    expect(spawnedStageNames).toEqual(["investigate"]);
    expect(orchestrator.getState().issueStages["1"]).toBe("investigate");
  });

  it("fast-track: case-insensitive label matching (label already normalized to lowercase by linear-normalize.ts)", async () => {
    // Labels are normalized to lowercase upstream — "trivial" in config matches "trivial" in issue
    const spawnedStageNames: Array<string | null> = [];
    const orchestrator = new OrchestratorCore({
      config: createFastTrackConfig(),
      tracker: createTracker({
        candidates: [
          // label is already normalized to lowercase "trivial" (as linear-normalize.ts does)
          createIssue({
            id: "1",
            identifier: "ISSUE-1",
            state: "Todo",
            labels: ["trivial"],
          }),
        ],
      }),
      spawnWorker: async ({ stageName }) => {
        spawnedStageNames.push(stageName);
        return {
          workerHandle: { pid: 1001 },
          monitorHandle: { ref: "monitor-1" },
        };
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();

    expect(spawnedStageNames).toEqual(["implement"]);
  });

  it("fast-track: issue with cached stage ignores fast-track and continues from cached stage", async () => {
    const spawnedStageNames: Array<string | null> = [];
    const orchestrator = new OrchestratorCore({
      config: createFastTrackConfig(),
      tracker: createTracker({
        candidates: [
          createIssue({
            id: "1",
            identifier: "ISSUE-1",
            state: "Todo",
            labels: ["trivial"],
          }),
        ],
      }),
      spawnWorker: async ({ stageName }) => {
        spawnedStageNames.push(stageName);
        return {
          workerHandle: { pid: 1001 },
          monitorHandle: { ref: "monitor-1" },
        };
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    // Pre-set a cached stage for this issue
    orchestrator.getState().issueStages["1"] = "review" as unknown as string;

    // Manually add a "review" stage to handle the cached stage scenario
    // (The orchestrator will use the cached "review" value — which is not in our test stage config
    // so stage will be null, but stageName will be "review", proving cached stage takes priority)
    const config = createFastTrackConfig();
    const orchestratorWithReview = new OrchestratorCore({
      config: {
        ...config,
        stages: config.stages
          ? {
              ...config.stages,
              stages: Object.freeze({
                ...config.stages.stages,
                review: {
                  type: "agent" as const,
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
                    onComplete: "done",
                    onApprove: null,
                    onRework: null,
                  },
                  linearState: null,
                },
              }),
            }
          : null,
      },
      tracker: createTracker({
        candidates: [
          createIssue({
            id: "1",
            identifier: "ISSUE-1",
            state: "Todo",
            labels: ["trivial"],
          }),
        ],
      }),
      spawnWorker: async ({ stageName }) => {
        spawnedStageNames.push(stageName);
        return {
          workerHandle: { pid: 1001 },
          monitorHandle: { ref: "monitor-1" },
        };
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    // Pre-set the cached stage — fast-track should be ignored
    orchestratorWithReview.getState().issueStages["1"] = "review";

    await orchestratorWithReview.pollTick();

    expect(spawnedStageNames).toEqual(["review"]);
    expect(orchestratorWithReview.getState().issueStages["1"]).toBe("review");
  });

  it("no fast-track: issue with trivial label uses default initialStage when no fast_track config", async () => {
    const spawnedStageNames: Array<string | null> = [];
    const configWithoutFastTrack = createFastTrackConfig();
    const orchestrator = new OrchestratorCore({
      config: {
        ...configWithoutFastTrack,
        stages: configWithoutFastTrack.stages
          ? { ...configWithoutFastTrack.stages, fastTrack: null }
          : null,
      },
      tracker: createTracker({
        candidates: [
          createIssue({
            id: "1",
            identifier: "ISSUE-1",
            state: "Todo",
            labels: ["trivial"],
          }),
        ],
      }),
      spawnWorker: async ({ stageName }) => {
        spawnedStageNames.push(stageName);
        return {
          workerHandle: { pid: 1001 },
          monitorHandle: { ref: "monitor-1" },
        };
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();

    expect(spawnedStageNames).toEqual(["investigate"]);
  });

  it("fast-track: logs activation message when fast-track is applied", async () => {
    const logs: string[] = [];
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      logs.push(args.join(" "));
    };

    try {
      const orchestrator = new OrchestratorCore({
        config: createFastTrackConfig(),
        tracker: createTracker({
          candidates: [
            createIssue({
              id: "1",
              identifier: "ISSUE-1",
              state: "Todo",
              labels: ["trivial"],
            }),
          ],
        }),
        spawnWorker: async () => ({
          workerHandle: { pid: 1001 },
          monitorHandle: { ref: "monitor-1" },
        }),
        now: () => new Date("2026-03-06T00:00:05.000Z"),
      });

      await orchestrator.pollTick();
    } finally {
      console.log = originalLog;
    }

    expect(logs).toContainEqual(
      "[orchestrator] Fast-tracking ISSUE-1 to implement (label: trivial)",
    );
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
      slackNotifyChannel: null,
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

describe("classifyExitOutcome", () => {
  it("classifies abnormal exit with turnCount=0 as failed_to_start", () => {
    expect(classifyExitOutcome("abnormal", 0, "some error")).toBe(
      "failed_to_start",
    );
  });

  it("classifies abnormal exit with stall_timeout in reason as timed_out", () => {
    expect(
      classifyExitOutcome("abnormal", 5, "stopped after stall_timeout"),
    ).toBe("timed_out");
  });

  it("classifies abnormal exit without stall_timeout as error", () => {
    expect(classifyExitOutcome("abnormal", 3, "some error message")).toBe(
      "error",
    );
  });

  it("passes through normal outcome unchanged", () => {
    expect(classifyExitOutcome("normal", 2, undefined)).toBe("normal");
  });

  it("passes through already classified outcomes unchanged", () => {
    expect(classifyExitOutcome("failed_to_start", 0, undefined)).toBe(
      "failed_to_start",
    );
    expect(classifyExitOutcome("timed_out", 3, undefined)).toBe("timed_out");
    expect(classifyExitOutcome("error", 1, undefined)).toBe("error");
  });
});
