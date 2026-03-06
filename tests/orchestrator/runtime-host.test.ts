import { describe, expect, it, vi } from "vitest";

import type {
  AgentRunResult,
  AgentRunnerEvent,
} from "../../src/agent/runner.js";
import type { ResolvedWorkflowConfig } from "../../src/config/types.js";
import type { Issue } from "../../src/domain/model.js";
import { OrchestratorRuntimeHost } from "../../src/orchestrator/runtime-host.js";
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
        path: "/tmp/workspaces/ISSUE-1",
        workspaceKey: "ISSUE-1",
        createdNow: true,
      },
      runAttempt: {
        issueId: "1",
        issueIdentifier: "ISSUE-1",
        attempt: null,
        workspacePath: "/tmp/workspaces/ISSUE-1",
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
        lastReportedInputTokens: 11,
        lastReportedOutputTokens: 7,
        lastReportedTotalTokens: 18,
        turnCount: 1,
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
      workspacePath: "/tmp/workspaces/ISSUE-1",
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
  };
}
