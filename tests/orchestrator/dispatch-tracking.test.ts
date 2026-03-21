import { describe, expect, it } from "vitest";

import type {
  ResolvedWorkflowConfig,
  StagesConfig,
} from "../../src/config/types.js";
import type { Issue } from "../../src/domain/model.js";
import { createInitialOrchestratorState } from "../../src/domain/model.js";
import { formatEasternTimestamp } from "../../src/logging/format-timestamp.js";
import {
  OrchestratorCore,
  type OrchestratorCoreOptions,
} from "../../src/orchestrator/core.js";
import type { IssueTracker } from "../../src/tracker/tracker.js";

describe("issueFirstDispatchedAt tracking", () => {
  it("createInitialOrchestratorState includes issueFirstDispatchedAt as empty object", () => {
    const state = createInitialOrchestratorState({
      pollIntervalMs: 30_000,
      maxConcurrentAgents: 2,
    });
    expect(state.issueFirstDispatchedAt).toEqual({});
  });

  it("first dispatch sets issueFirstDispatchedAt for that issue", async () => {
    const dispatchTime = new Date("2026-03-06T00:00:05.000Z");
    const orchestrator = createOrchestrator({
      now: () => dispatchTime,
    });

    await orchestrator.pollTick();

    expect(orchestrator.getState().issueFirstDispatchedAt["1"]).toBe(
      formatEasternTimestamp(dispatchTime),
    );
  });

  it("subsequent dispatch preserves original issueFirstDispatchedAt", async () => {
    const t1 = new Date("2026-03-06T00:00:05.000Z");
    const t2 = new Date("2026-03-06T00:01:00.000Z");
    let currentTime = t1;

    const orchestrator = createOrchestrator({
      stages: createTwoAgentStageConfig(),
      now: () => currentTime,
    });

    // First dispatch at T1
    await orchestrator.pollTick();
    expect(orchestrator.getState().issueFirstDispatchedAt["1"]).toBe(
      formatEasternTimestamp(t1),
    );

    // Worker exits, stage advances to "implement"
    orchestrator.onWorkerExit({ issueId: "1", outcome: "normal" });
    expect(orchestrator.getState().issueStages["1"]).toBe("implement");

    // Advance time to T2 before second dispatch
    currentTime = t2;
    await orchestrator.onRetryTimer("1");

    // issueFirstDispatchedAt must still be T1, not T2
    expect(orchestrator.getState().issueFirstDispatchedAt["1"]).toBe(
      formatEasternTimestamp(t1),
    );
  });

  it("terminal cleanup deletes issueFirstDispatchedAt", async () => {
    const orchestrator = createOrchestrator({
      stages: createTerminalStageConfig(),
    });

    // Dispatch to "implement" stage — sets issueFirstDispatchedAt
    await orchestrator.pollTick();
    expect(orchestrator.getState().issueFirstDispatchedAt["1"]).toBeDefined();

    // Normal exit advances to "done" (terminal) — triggers cleanup
    orchestrator.onWorkerExit({ issueId: "1", outcome: "normal" });

    expect(orchestrator.getState().issueFirstDispatchedAt["1"]).toBeUndefined();
    expect(orchestrator.getState().completed.has("1")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createOrchestrator(overrides?: {
  stages?: StagesConfig | null;
  now?: () => Date;
}) {
  const stages = overrides?.stages !== undefined ? overrides.stages : null;

  const options: OrchestratorCoreOptions = {
    config: createConfig({ stages }),
    tracker: createTracker({
      candidates: [createIssue({ id: "1", identifier: "ISSUE-1" })],
    }),
    spawnWorker: async () => ({
      workerHandle: { pid: 1001 },
      monitorHandle: { ref: "monitor-1" },
    }),
    now: overrides?.now ?? (() => new Date("2026-03-06T00:00:05.000Z")),
  };

  return new OrchestratorCore(options);
}

function createTracker(input?: { candidates?: Issue[] }): IssueTracker {
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
      return [];
    },
  };
}

function createConfig(overrides?: {
  stages?: StagesConfig | null;
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
    stages: overrides?.stages ?? null,
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

/** Two agent stages followed by a terminal stage — used to test second dispatch. */
function createTwoAgentStageConfig(): StagesConfig {
  return {
    initialStage: "investigate",
    fastTrack: null,
    stages: {
      investigate: {
        type: "agent",
        runner: "claude-code",
        model: "claude-opus-4",
        prompt: "investigate.liquid",
        maxTurns: 8,
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
        runner: "claude-code",
        model: "claude-sonnet-4-5",
        prompt: "implement.liquid",
        maxTurns: 30,
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
  };
}

/** One agent stage leading to a terminal stage — used to test cleanup. */
function createTerminalStageConfig(): StagesConfig {
  return {
    initialStage: "implement",
    fastTrack: null,
    stages: {
      implement: {
        type: "agent",
        runner: "claude-code",
        model: "claude-sonnet-4-5",
        prompt: "implement.liquid",
        maxTurns: 30,
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
    },
  };
}
