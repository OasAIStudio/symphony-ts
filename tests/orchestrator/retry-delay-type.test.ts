import { describe, expect, it } from "vitest";

import type { ResolvedWorkflowConfig } from "../../src/config/types.js";
import type { Issue } from "../../src/domain/model.js";
import { OrchestratorCore } from "../../src/orchestrator/core.js";
import type { IssueTracker } from "../../src/tracker/tracker.js";

describe("onRetryTimer preserves delayType from retry entry", () => {
  it("preserves continuation delayType when tracker fetch fails", async () => {
    let fetchCallCount = 0;
    const tracker: IssueTracker = {
      async fetchCandidateIssues() {
        fetchCallCount++;
        // First call succeeds (pollTick dispatch), subsequent calls fail
        if (fetchCallCount <= 1) {
          return [createIssue({ id: "1", identifier: "ISSUE-1" })];
        }
        throw new Error("tracker API outage");
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }];
      },
    };

    const timers = createFakeTimerScheduler();
    const orchestrator = new OrchestratorCore({
      config: createConfig({ agent: { maxRetryAttempts: 2 } }),
      tracker,
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      timerScheduler: timers,
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    // Dispatch via pollTick
    await orchestrator.pollTick();

    // Normal exit -> continuation retry (attempt=1, delayType="continuation")
    const retryEntry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      endedAt: new Date("2026-03-06T00:00:05.000Z"),
    });

    expect(retryEntry).not.toBeNull();
    expect(retryEntry).toMatchObject({
      issueId: "1",
      attempt: 1,
      delayType: "continuation",
    });

    // Fire retry timer — tracker fetch will fail
    const result = await orchestrator.onRetryTimer("1");

    expect(result.dispatched).toBe(false);
    expect(result.released).toBe(false);
    // The rescheduled retry must preserve delayType: "continuation"
    expect(result.retryEntry).not.toBeNull();
    expect(result.retryEntry).toMatchObject({
      issueId: "1",
      attempt: 2,
      error: "retry poll failed",
      delayType: "continuation",
    });

    // Continuation retries should NOT count against maxRetryAttempts.
    // The issue is in the completed set because onWorkerExit adds it there
    // before scheduling a continuation retry (this is normal — completed
    // issues can be resumed via the "Resume"/"Todo" state check).
    // The key assertion is that claimed is still true (not released/escalated).
    expect(orchestrator.getState().claimed.has("1")).toBe(true);
  });

  it("preserves failure delayType when tracker fetch fails", async () => {
    let fetchCallCount = 0;
    const tracker: IssueTracker = {
      async fetchCandidateIssues() {
        fetchCallCount++;
        if (fetchCallCount <= 1) {
          return [createIssue({ id: "1", identifier: "ISSUE-1" })];
        }
        throw new Error("tracker API outage");
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }];
      },
    };

    const timers = createFakeTimerScheduler();
    const orchestrator = new OrchestratorCore({
      config: createConfig({ agent: { maxRetryAttempts: 5 } }),
      tracker,
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      timerScheduler: timers,
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();

    // Abnormal exit -> failure retry (attempt=1, delayType="failure")
    const retryEntry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: "turn failed",
    });

    expect(retryEntry).not.toBeNull();
    expect(retryEntry).toMatchObject({
      issueId: "1",
      attempt: 1,
      delayType: "failure",
    });

    // Fire retry timer — tracker fetch will fail
    const result = await orchestrator.onRetryTimer("1");

    expect(result.dispatched).toBe(false);
    expect(result.released).toBe(false);
    expect(result.retryEntry).not.toBeNull();
    expect(result.retryEntry).toMatchObject({
      issueId: "1",
      attempt: 2,
      error: "retry poll failed",
      delayType: "failure",
    });
  });

  it("preserves continuation delayType when no orchestrator slots available", async () => {
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
    };

    const orchestrator = new OrchestratorCore({
      config: createConfig({
        agent: { maxConcurrentAgents: 0, maxRetryAttempts: 2 },
      }),
      tracker,
      spawnWorker: async () => ({
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      }),
      timerScheduler: timers,
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    // Manually create a continuation retry entry
    orchestrator.getState().claimed.add("1");
    orchestrator.getState().retryAttempts["1"] = {
      issueId: "1",
      identifier: "ISSUE-1",
      attempt: 1,
      dueAtMs: Date.parse("2026-03-06T00:00:00.000Z"),
      timerHandle: null,
      error: null,
      delayType: "continuation",
    };

    // Fire retry timer — no slots available
    const result = await orchestrator.onRetryTimer("1");

    expect(result.dispatched).toBe(false);
    expect(result.released).toBe(false);
    expect(result.retryEntry).not.toBeNull();
    expect(result.retryEntry).toMatchObject({
      issueId: "1",
      attempt: 2,
      error: "no available orchestrator slots",
      delayType: "continuation",
    });

    // Continuation retries should NOT trigger escalation
    expect(orchestrator.getState().completed.has("1")).toBe(false);
    expect(orchestrator.getState().claimed.has("1")).toBe(true);
  });

  it("continuation retry that hits repeated tracker failures does NOT escalate at maxRetryAttempts", async () => {
    const escalationComments: Array<{ issueId: string; body: string }> = [];
    let fetchCallCount = 0;
    const tracker: IssueTracker = {
      async fetchCandidateIssues() {
        fetchCallCount++;
        if (fetchCallCount <= 1) {
          return [createIssue({ id: "1", identifier: "ISSUE-1" })];
        }
        throw new Error("tracker API outage");
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }];
      },
    };

    const timers = createFakeTimerScheduler();
    const orchestrator = new OrchestratorCore({
      config: createConfig({ agent: { maxRetryAttempts: 2 } }),
      tracker,
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

    // Dispatch via pollTick
    await orchestrator.pollTick();

    // Normal exit -> continuation retry (attempt=1)
    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      endedAt: new Date("2026-03-06T00:00:05.000Z"),
    });

    // First tracker failure: continuation retry bumps to attempt=2
    const result1 = await orchestrator.onRetryTimer("1");
    expect(result1.retryEntry).toMatchObject({
      attempt: 2,
      delayType: "continuation",
    });

    // Second tracker failure: continuation retry bumps to attempt=3
    // With maxRetryAttempts=2, a failure retry at attempt=3 would escalate.
    // But since this is a continuation, it should NOT escalate.
    const result2 = await orchestrator.onRetryTimer("1");
    expect(result2.retryEntry).not.toBeNull();
    expect(result2.retryEntry).toMatchObject({
      attempt: 3,
      delayType: "continuation",
    });

    // No escalation should have occurred — the key assertion is that
    // escalationComments is empty and the claim is still held.
    // completed is true because onWorkerExit marks normal exits as completed
    // before scheduling continuation retries (this is normal behavior).
    expect(escalationComments).toHaveLength(0);
    expect(orchestrator.getState().claimed.has("1")).toBe(true);
  });

  it("failure retry that hits repeated tracker failures DOES escalate at maxRetryAttempts", async () => {
    const escalationComments: Array<{ issueId: string; body: string }> = [];
    let fetchCallCount = 0;
    const tracker: IssueTracker = {
      async fetchCandidateIssues() {
        fetchCallCount++;
        if (fetchCallCount <= 1) {
          return [createIssue({ id: "1", identifier: "ISSUE-1" })];
        }
        throw new Error("tracker API outage");
      },
      async fetchIssuesByStates() {
        return [];
      },
      async fetchIssueStatesByIds() {
        return [{ id: "1", identifier: "ISSUE-1", state: "In Progress" }];
      },
    };

    const timers = createFakeTimerScheduler();
    const orchestrator = new OrchestratorCore({
      config: createConfig({ agent: { maxRetryAttempts: 2 } }),
      tracker,
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

    // Dispatch via pollTick
    await orchestrator.pollTick();

    // Abnormal exit -> failure retry (attempt=1)
    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: "turn failed",
    });

    // First tracker failure: failure retry bumps to attempt=2 (at limit)
    const result1 = await orchestrator.onRetryTimer("1");
    expect(result1.retryEntry).toMatchObject({
      attempt: 2,
      delayType: "failure",
    });

    // Second tracker failure: failure retry bumps to attempt=3 (exceeds limit of 2)
    // This SHOULD escalate
    const result2 = await orchestrator.onRetryTimer("1");
    expect(result2.retryEntry).toBeNull();

    // Escalation should have occurred
    expect(escalationComments).toHaveLength(1);
    expect(escalationComments[0]?.body).toContain(
      "Max retry attempts (2) exceeded",
    );
    expect(orchestrator.getState().failed.has("1")).toBe(true);
    expect(orchestrator.getState().claimed.has("1")).toBe(false);
  });
});

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

function createConfig(overrides?: {
  agent?: Partial<ResolvedWorkflowConfig["agent"]>;
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
