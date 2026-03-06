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
    expect(runningEntry).toBeDefined();
    if (runningEntry === undefined) {
      throw new Error("Expected issue 1 to be running.");
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
