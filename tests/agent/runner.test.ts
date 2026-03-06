import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ResolvedWorkflowConfig } from "../../src/config/types.js";
import type { Issue } from "../../src/domain/model.js";
import { ERROR_CODES } from "../../src/errors/codes.js";
import {
  AgentRunner,
  type AgentRunnerCodexClientFactoryInput,
  type AgentRunnerError,
  WorkspaceHookError,
} from "../../src/index.js";
import type {
  IssueStateSnapshot,
  IssueTracker,
} from "../../src/tracker/tracker.js";

const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/codex-fake-server.mjs",
);

const roots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    roots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("AgentRunner", () => {
  it("runs a single issue through workspace setup, dynamic Linear tool injection, continuation turns, and state refresh", async () => {
    const root = await createRoot();
    const tracker = createTracker({
      refreshStates: [
        { id: "issue-1", identifier: "ABC-123", state: "In Progress" },
        { id: "issue-1", identifier: "ABC-123", state: "Done" },
      ],
    });
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          viewer: {
            id: "viewer-1",
            name: "Example User",
          },
        },
      }),
    );
    const events: Array<{
      event: string;
      workspacePath: string;
      turnCount: number;
    }> = [];
    const runner = new AgentRunner({
      config: createConfig(root, "linear-tool"),
      tracker,
      fetchFn,
      onEvent: (event) => {
        events.push({
          event: event.event,
          workspacePath: event.workspacePath,
          turnCount: event.turnCount,
        });
      },
    });

    const result = await runner.run({
      issue: ISSUE_FIXTURE,
      attempt: null,
    });

    expect(result.runAttempt.status).toBe("succeeded");
    expect(result.workspace.createdNow).toBe(true);
    expect(result.turnsCompleted).toBe(2);
    expect(result.issue.state).toBe("Done");
    expect(result.liveSession.threadId).toBe("thread-1");
    expect(result.liveSession.turnId).toBe("turn-2");
    expect(result.liveSession.turnCount).toBe(2);
    expect(result.rateLimits).toEqual({
      requests_remaining: 9,
      tokens_remaining: 999,
    });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(tracker.fetchIssueStatesByIds).toHaveBeenCalledTimes(2);
    expect(events.map((event) => event.event)).toContain("turn_completed");
    expect(events.at(-1)).toEqual(
      expect.objectContaining({
        workspacePath: result.workspace.path,
        turnCount: 2,
      }),
    );
  });

  it("sends the rendered workflow prompt first and continuation guidance afterwards", async () => {
    const root = await createRoot();
    const prompts: string[] = [];
    const tracker = createTracker({
      refreshStates: [
        { id: "issue-1", identifier: "ABC-123", state: "In Progress" },
        { id: "issue-1", identifier: "ABC-123", state: "Human Review" },
      ],
    });
    const runner = new AgentRunner({
      config: createConfig(root, "unused"),
      tracker,
      createCodexClient: (input) =>
        createStubCodexClient(prompts, input, {
          statuses: ["completed", "completed"],
        }),
    });

    const result = await runner.run({
      issue: ISSUE_FIXTURE,
      attempt: 2,
    });

    expect(result.turnsCompleted).toBe(2);
    expect(prompts[0]).toBe("Initial prompt for ABC-123 attempt=2");
    expect(prompts[1]).toContain("Continue working on issue ABC-123");
    expect(prompts[1]).toContain("continuation turn 2 of 3");
    expect(prompts[1]).not.toContain("Initial prompt for ABC-123 attempt=2");
  });

  it("fails immediately when before_run fails and does not invoke after_run", async () => {
    const root = await createRoot();
    const hooks = {
      run: vi.fn(async ({ name }: { name: string }) => {
        if (name !== "beforeRun") {
          return false;
        }

        throw new WorkspaceHookError({
          code: ERROR_CODES.hookFailed,
          message: "before_run hook failed",
          hook: "beforeRun",
          workspacePath: join(root, "ABC-123"),
          exitCode: 1,
        });
      }),
      runBestEffort: vi.fn(),
    };
    const createCodexClient = vi.fn();
    const runner = new AgentRunner({
      config: createConfig(root, "unused"),
      tracker: createTracker(),
      hooks: hooks as never,
      createCodexClient,
    });

    await expect(
      runner.run({
        issue: ISSUE_FIXTURE,
        attempt: null,
      }),
    ).rejects.toMatchObject({
      name: "AgentRunnerError",
      code: ERROR_CODES.hookFailed,
      status: "failed",
      failedPhase: "preparing_workspace",
    } satisfies Partial<AgentRunnerError>);

    expect(createCodexClient).not.toHaveBeenCalled();
    expect(hooks.runBestEffort).not.toHaveBeenCalled();
  });

  it("closes the session and still runs after_run best-effort when refresh fails", async () => {
    const root = await createRoot();
    const close = vi.fn().mockResolvedValue(undefined);
    const hooks = {
      run: vi.fn().mockResolvedValue(true),
      runBestEffort: vi.fn().mockResolvedValue(false),
    };
    const runner = new AgentRunner({
      config: createConfig(root, "unused"),
      tracker: {
        fetchCandidateIssues: vi.fn(),
        fetchIssuesByStates: vi.fn(),
        fetchIssueStatesByIds: vi
          .fn()
          .mockRejectedValue(new Error("refresh failed")),
      },
      hooks: hooks as never,
      createCodexClient: (input) =>
        createStubCodexClient([], input, {
          close,
          statuses: ["completed"],
        }),
    });

    await expect(
      runner.run({
        issue: ISSUE_FIXTURE,
        attempt: null,
      }),
    ).rejects.toMatchObject({
      name: "AgentRunnerError",
      status: "failed",
      failedPhase: "finishing",
      message: "refresh failed",
    } satisfies Partial<AgentRunnerError>);

    expect(close).toHaveBeenCalledTimes(1);
    expect(hooks.runBestEffort).toHaveBeenCalledWith({
      name: "afterRun",
      workspacePath: expect.stringContaining("ABC-123"),
    });
  });
});

function createStubCodexClient(
  prompts: string[],
  input: AgentRunnerCodexClientFactoryInput,
  overrides?: Partial<{
    close: ReturnType<typeof vi.fn>;
    statuses: Array<"completed" | "failed" | "cancelled">;
  }>,
) {
  let turn = 0;
  const statuses = overrides?.statuses ?? ["completed"];

  return {
    async startSession({ prompt }: { prompt: string; title: string }) {
      turn += 1;
      prompts.push(prompt);
      input.onEvent({
        event: "session_started",
        timestamp: new Date("2026-03-06T00:00:00.000Z").toISOString(),
        codexAppServerPid: "1001",
        sessionId: `thread-1-turn-${turn}`,
        threadId: "thread-1",
        turnId: `turn-${turn}`,
      });
      return {
        status: statuses[turn - 1] ?? "completed",
        threadId: "thread-1",
        turnId: `turn-${turn}`,
        sessionId: `thread-1-turn-${turn}`,
        usage: {
          inputTokens: 10 * turn,
          outputTokens: 5 * turn,
          totalTokens: 15 * turn,
        },
        rateLimits: {
          requestsRemaining: 10 - turn,
        },
        message: `turn ${turn}`,
      };
    },
    async continueTurn(prompt: string) {
      turn += 1;
      prompts.push(prompt);
      input.onEvent({
        event: "session_started",
        timestamp: new Date("2026-03-06T00:00:00.000Z").toISOString(),
        codexAppServerPid: "1001",
        sessionId: `thread-1-turn-${turn}`,
        threadId: "thread-1",
        turnId: `turn-${turn}`,
      });
      return {
        status: statuses[turn - 1] ?? "completed",
        threadId: "thread-1",
        turnId: `turn-${turn}`,
        sessionId: `thread-1-turn-${turn}`,
        usage: {
          inputTokens: 10 * turn,
          outputTokens: 5 * turn,
          totalTokens: 15 * turn,
        },
        rateLimits: {
          requestsRemaining: 10 - turn,
        },
        message: `turn ${turn}`,
      };
    },
    close: overrides?.close ?? vi.fn().mockResolvedValue(undefined),
  };
}

function createTracker(input?: {
  refreshStates?: IssueStateSnapshot[];
}): IssueTracker {
  const refreshStates = [...(input?.refreshStates ?? [])];

  return {
    fetchCandidateIssues: vi.fn(),
    fetchIssuesByStates: vi.fn(),
    fetchIssueStatesByIds: vi.fn(async () => {
      const next = refreshStates.shift();
      return next === undefined ? [] : [next];
    }),
  };
}

function createConfig(root: string, scenario: string): ResolvedWorkflowConfig {
  return {
    workflowPath: join(root, "WORKFLOW.md"),
    promptTemplate:
      "Initial prompt for {{ issue.identifier }} attempt={{ attempt }}",
    tracker: {
      kind: "linear",
      endpoint: "https://api.linear.app/graphql",
      apiKey: "linear-token",
      projectSlug: "example",
      activeStates: ["In Progress"],
      terminalStates: ["Done", "Canceled"],
    },
    polling: {
      intervalMs: 30_000,
    },
    workspace: {
      root,
    },
    hooks: {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 500,
    },
    agent: {
      maxConcurrentAgents: 2,
      maxTurns: 3,
      maxRetryBackoffMs: 300_000,
      maxConcurrentAgentsByState: {},
    },
    codex: {
      command: `${process.execPath} "${fixturePath}" ${scenario}`,
      approvalPolicy: "full-auto",
      threadSandbox: "workspace-write",
      turnSandboxPolicy: {
        type: "workspace-write",
      },
      turnTimeoutMs: 1_000,
      readTimeoutMs: 1_000,
      stallTimeoutMs: 2_000,
    },
    server: {
      port: null,
    },
  };
}

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "symphony-task11-"));
  roots.push(root);
  return root;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

const ISSUE_FIXTURE: Issue = {
  id: "issue-1",
  identifier: "ABC-123",
  title: "Ship agent runner",
  description: "Implement the runner",
  priority: 1,
  state: "In Progress",
  branchName: null,
  url: "https://linear.app/example/issue/ABC-123",
  labels: ["automation"],
  blockedBy: [],
  createdAt: "2026-03-06T00:00:00.000Z",
  updatedAt: "2026-03-06T01:00:00.000Z",
};
