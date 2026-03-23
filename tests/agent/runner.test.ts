import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
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

  it("keeps the workspace path stable when the issue identifier changes", async () => {
    const root = await createRoot();
    const tracker = createTracker({
      refreshStates: [
        { id: "issue-1", identifier: "RENAMED-456", state: "Done" },
      ],
    });
    const runner = new AgentRunner({
      config: createConfig(root, "unused"),
      tracker,
      createCodexClient: (input) =>
        createStubCodexClient([], input, {
          statuses: ["completed"],
        }),
    });

    const result = await runner.run({
      issue: ISSUE_FIXTURE,
      attempt: null,
    });

    expect(result.issue.identifier).toBe("RENAMED-456");
    expect(result.workspace.path).toBe(join(root, "issue-1"));
    expect(result.runAttempt.workspacePath).toBe(join(root, "issue-1"));
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

  it("emits promptChars and estimatedPromptTokens on agent events, with turn 1 larger than turn 2 for a long template", async () => {
    const root = await createRoot();
    const prompts: string[] = [];
    const capturedEvents: Array<{
      event: string;
      promptChars: number | undefined;
      estimatedPromptTokens: number | undefined;
      turnCount: number;
    }> = [];
    const tracker = createTracker({
      refreshStates: [
        { id: "issue-1", identifier: "ABC-123", state: "In Progress" },
        { id: "issue-1", identifier: "ABC-123", state: "Human Review" },
      ],
    });
    // Use a long template (>600 chars) so turn 1 prompt is larger than the continuation prompt
    const longTemplate =
      "You are an expert software engineer working on the following issue.\n\nIssue: {{ issue.identifier }}\nTitle: {{ issue.title }}\nDescription: {{ issue.description }}\nState: {{ issue.state }}\nAttempt: {{ attempt }}\n\nInstructions:\n- Read the issue description carefully.\n- Implement all required changes.\n- Write tests for any new functionality.\n- Run the full test suite and fix any failures.\n- Follow the existing code style and conventions.\n- Write clear commit messages.\n- Open a pull request when done.\n- Do not modify unrelated code.\n- Do not skip tests.\n- Document any architectural decisions.\n";
    const runner = new AgentRunner({
      config: { ...createConfig(root, "unused"), promptTemplate: longTemplate },
      tracker,
      onEvent: (event) => {
        capturedEvents.push({
          event: event.event,
          promptChars: event.promptChars,
          estimatedPromptTokens: event.estimatedPromptTokens,
          turnCount: event.turnCount,
        });
      },
      createCodexClient: (input) =>
        createStubCodexClient(prompts, input, {
          statuses: ["completed", "completed"],
        }),
    });

    await runner.run({
      issue: ISSUE_FIXTURE,
      attempt: null,
    });

    expect(prompts).toHaveLength(2);

    // Events for turn 1 should carry turn 1 prompt metrics
    const turn1Events = capturedEvents.filter((e) => e.turnCount === 1);
    expect(turn1Events.length).toBeGreaterThan(0);
    const turn1PromptChars = turn1Events[0]?.promptChars;
    expect(turn1PromptChars).toBe(prompts[0]?.length);
    expect(turn1Events[0]?.estimatedPromptTokens).toBe(
      Math.ceil((turn1PromptChars ?? 0) / 4),
    );

    // Events for turn 2 should carry turn 2 prompt metrics
    const turn2Events = capturedEvents.filter((e) => e.turnCount === 2);
    expect(turn2Events.length).toBeGreaterThan(0);
    const turn2PromptChars = turn2Events[0]?.promptChars;
    expect(turn2PromptChars).toBe(prompts[1]?.length);
    expect(turn2Events[0]?.estimatedPromptTokens).toBe(
      Math.ceil((turn2PromptChars ?? 0) / 4),
    );

    // Turn 1 (full WORKFLOW template) should be larger than turn 2 (continuation)
    expect(turn1PromptChars).toBeGreaterThan(turn2PromptChars ?? 0);
  });

  it("fails immediately when before_run fails and still invokes after_run best-effort", async () => {
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
          workspacePath: join(root, "issue-1"),
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
    expect(hooks.runBestEffort).toHaveBeenCalledWith({
      name: "afterRun",
      workspacePath: join(root, "issue-1"),
    });
  });

  it("removes temporary workspace artifacts before each attempt starts", async () => {
    const root = await createRoot();
    const workspacePath = join(root, "issue-1");
    await mkdir(join(workspacePath, "tmp"), { recursive: true });

    const hooks = {
      run: vi.fn(
        async ({
          name,
          workspacePath,
        }: {
          name: string;
          workspacePath: string;
        }) => {
          if (name === "beforeRun") {
            await expect(
              stat(join(workspacePath, "tmp")),
            ).rejects.toMatchObject({ code: "ENOENT" });
          }
          return true;
        },
      ),
      runBestEffort: vi.fn().mockResolvedValue(true),
    };

    const runner = new AgentRunner({
      config: createConfig(root, "unused"),
      tracker: createTracker({
        refreshStates: [
          { id: "issue-1", identifier: "ABC-123", state: "Done" },
        ],
      }),
      hooks: hooks as never,
      createCodexClient: (input) =>
        createStubCodexClient([], input, {
          statuses: ["completed"],
        }),
    });

    const result = await runner.run({
      issue: ISSUE_FIXTURE,
      attempt: null,
    });

    expect(result.runAttempt.status).toBe("succeeded");
    expect(hooks.run).toHaveBeenCalledWith({
      name: "beforeRun",
      workspacePath,
    });
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
      workspacePath: expect.stringContaining("issue-1"),
    });
  });

  it("removes existing workspace on fresh dispatch at initial stage", async () => {
    const root = await createRoot();
    const workspacePath = join(root, "issue-1");
    const removeForIssue = vi.fn().mockResolvedValue(true);
    const createForIssue = vi.fn().mockResolvedValue({
      path: workspacePath,
      workspaceKey: "issue-1",
      createdNow: true,
    });
    const mockWorkspaceManager = {
      root,
      createForIssue,
      removeForIssue,
      resolveForIssue: vi.fn(),
    };
    const config = createConfig(root, "unused");
    config.stages = {
      initialStage: "investigate",
      fastTrack: null,
      stages: {
        investigate: {
          type: "agent",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: 3,
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
          linearState: null,
        },
      },
    };
    const runner = new AgentRunner({
      config,
      tracker: createTracker({
        refreshStates: [
          { id: "issue-1", identifier: "ABC-123", state: "Done" },
        ],
      }),
      workspaceManager: mockWorkspaceManager as never,
      createCodexClient: (input) =>
        createStubCodexClient([], input, {
          statuses: ["completed"],
        }),
    });

    await runner.run({
      issue: ISSUE_FIXTURE,
      attempt: null,
      stageName: "investigate",
    });

    expect(removeForIssue).toHaveBeenCalledWith("issue-1");
    expect(createForIssue).toHaveBeenCalledWith("issue-1");
  });

  it("does NOT remove workspace on flat dispatch (no stages)", async () => {
    const root = await createRoot();
    const workspacePath = join(root, "issue-1");
    const removeForIssue = vi.fn().mockResolvedValue(true);
    const createForIssue = vi.fn().mockResolvedValue({
      path: workspacePath,
      workspaceKey: "issue-1",
      createdNow: false,
    });
    const mockWorkspaceManager = {
      root,
      createForIssue,
      removeForIssue,
      resolveForIssue: vi.fn(),
    };
    const runner = new AgentRunner({
      config: createConfig(root, "unused"),
      tracker: createTracker({
        refreshStates: [
          { id: "issue-1", identifier: "ABC-123", state: "Done" },
        ],
      }),
      workspaceManager: mockWorkspaceManager as never,
      createCodexClient: (input) =>
        createStubCodexClient([], input, {
          statuses: ["completed"],
        }),
    });

    await runner.run({
      issue: ISSUE_FIXTURE,
      attempt: null,
    });

    expect(removeForIssue).not.toHaveBeenCalled();
    expect(createForIssue).toHaveBeenCalledWith("issue-1");
  });

  it("does NOT remove workspace on continuation (attempt !== null)", async () => {
    const root = await createRoot();
    const workspacePath = join(root, "issue-1");
    const removeForIssue = vi.fn().mockResolvedValue(true);
    const createForIssue = vi.fn().mockResolvedValue({
      path: workspacePath,
      workspaceKey: "issue-1",
      createdNow: false,
    });
    const mockWorkspaceManager = {
      root,
      createForIssue,
      removeForIssue,
      resolveForIssue: vi.fn(),
    };
    const runner = new AgentRunner({
      config: createConfig(root, "unused"),
      tracker: createTracker({
        refreshStates: [
          { id: "issue-1", identifier: "ABC-123", state: "Done" },
        ],
      }),
      workspaceManager: mockWorkspaceManager as never,
      createCodexClient: (input) =>
        createStubCodexClient([], input, {
          statuses: ["completed"],
        }),
    });

    await runner.run({
      issue: ISSUE_FIXTURE,
      attempt: 1,
    });

    expect(removeForIssue).not.toHaveBeenCalled();
    expect(createForIssue).toHaveBeenCalledWith("issue-1");
  });

  it("breaks the turn loop early when the agent emits [STAGE_COMPLETE]", async () => {
    const root = await createRoot();
    const tracker = createTracker({
      refreshStates: [
        // Would keep going if not for early exit — issue stays active
        { id: "issue-1", identifier: "ABC-123", state: "In Progress" },
        { id: "issue-1", identifier: "ABC-123", state: "In Progress" },
      ],
    });
    const runner = new AgentRunner({
      config: createConfig(root, "unused"),
      tracker,
      createCodexClient: (input) => {
        let turn = 0;
        return {
          async startSession({ prompt }: { prompt: string; title: string }) {
            turn += 1;
            input.onEvent({
              event: "session_started",
              timestamp: new Date().toISOString(),
              codexAppServerPid: "1001",
              sessionId: `thread-1-turn-${turn}`,
              threadId: "thread-1",
              turnId: `turn-${turn}`,
            });
            return {
              status: "completed" as const,
              threadId: "thread-1",
              turnId: `turn-${turn}`,
              sessionId: `thread-1-turn-${turn}`,
              usage: null,
              rateLimits: null,
              message: "Done with investigation.\n[STAGE_COMPLETE]",
            };
          },
          async continueTurn(prompt: string) {
            turn += 1;
            input.onEvent({
              event: "session_started",
              timestamp: new Date().toISOString(),
              codexAppServerPid: "1001",
              sessionId: `thread-1-turn-${turn}`,
              threadId: "thread-1",
              turnId: `turn-${turn}`,
            });
            return {
              status: "completed" as const,
              threadId: "thread-1",
              turnId: `turn-${turn}`,
              sessionId: `thread-1-turn-${turn}`,
              usage: null,
              rateLimits: null,
              message: `turn ${turn}`,
            };
          },
          close: vi.fn().mockResolvedValue(undefined),
        };
      },
    });

    const result = await runner.run({
      issue: ISSUE_FIXTURE,
      attempt: null,
      stageName: "investigate",
    });

    // maxTurns is 3, but should break after turn 1 due to [STAGE_COMPLETE]
    expect(result.turnsCompleted).toBe(1);
    expect(result.runAttempt.status).toBe("succeeded");
    // refreshIssueState should NOT have been called since we broke before it
    expect(tracker.fetchIssueStatesByIds).not.toHaveBeenCalled();
  });

  it("breaks the turn loop early when the agent emits [STAGE_FAILED: ...]", async () => {
    const root = await createRoot();
    const tracker = createTracker({
      refreshStates: [
        { id: "issue-1", identifier: "ABC-123", state: "In Progress" },
        { id: "issue-1", identifier: "ABC-123", state: "In Progress" },
      ],
    });
    const runner = new AgentRunner({
      config: createConfig(root, "unused"),
      tracker,
      createCodexClient: (input) => {
        let turn = 0;
        return {
          async startSession({ prompt }: { prompt: string; title: string }) {
            turn += 1;
            input.onEvent({
              event: "session_started",
              timestamp: new Date().toISOString(),
              codexAppServerPid: "1001",
              sessionId: `thread-1-turn-${turn}`,
              threadId: "thread-1",
              turnId: `turn-${turn}`,
            });
            return {
              status: "completed" as const,
              threadId: "thread-1",
              turnId: `turn-${turn}`,
              sessionId: `thread-1-turn-${turn}`,
              usage: null,
              rateLimits: null,
              message: "Tests failed.\n[STAGE_FAILED: verify]\nSee logs.",
            };
          },
          async continueTurn(prompt: string) {
            turn += 1;
            input.onEvent({
              event: "session_started",
              timestamp: new Date().toISOString(),
              codexAppServerPid: "1001",
              sessionId: `thread-1-turn-${turn}`,
              threadId: "thread-1",
              turnId: `turn-${turn}`,
            });
            return {
              status: "completed" as const,
              threadId: "thread-1",
              turnId: `turn-${turn}`,
              sessionId: `thread-1-turn-${turn}`,
              usage: null,
              rateLimits: null,
              message: `turn ${turn}`,
            };
          },
          close: vi.fn().mockResolvedValue(undefined),
        };
      },
    });

    const result = await runner.run({
      issue: ISSUE_FIXTURE,
      attempt: null,
      stageName: "implement",
    });

    // maxTurns is 3, but should break after turn 1 due to [STAGE_FAILED: verify]
    expect(result.turnsCompleted).toBe(1);
    expect(result.lastTurn?.message).toContain("[STAGE_FAILED: verify]");
  });

  it("throws AgentRunnerError when a turn fails without a STAGE_FAILED signal", async () => {
    const root = await createRoot();
    const tracker = createTracker({
      refreshStates: [
        { id: "issue-1", identifier: "ABC-123", state: "In Progress" },
      ],
    });
    const runner = new AgentRunner({
      config: createConfig(root, "unused"),
      tracker,
      createCodexClient: (input) =>
        createStubCodexClient([], input, {
          statuses: ["failed"],
          messages: ["The operation was aborted"],
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
      failedPhase: "initializing_session",
      message: "The operation was aborted",
    } satisfies Partial<AgentRunnerError>);

    // Should NOT have called refreshIssueState since we threw before it
    expect(tracker.fetchIssueStatesByIds).not.toHaveBeenCalled();
  });

  it("returns succeeded when infrastructure marks turn failed but agent emitted STAGE_FAILED signal", async () => {
    const root = await createRoot();
    const tracker = createTracker({
      refreshStates: [
        { id: "issue-1", identifier: "ABC-123", state: "In Progress" },
      ],
    });
    const runner = new AgentRunner({
      config: createConfig(root, "unused"),
      tracker,
      createCodexClient: (input) =>
        createStubCodexClient([], input, {
          statuses: ["failed"],
          messages: ["Tests failed.\n[STAGE_FAILED: verify]\nSee logs."],
        }),
    });

    const result = await runner.run({
      issue: ISSUE_FIXTURE,
      attempt: null,
    });

    // STAGE_FAILED is an intentional agent signal — runner should succeed
    expect(result.runAttempt.status).toBe("succeeded");
    expect(result.lastTurn?.message).toContain("[STAGE_FAILED: verify]");
  });

  it("cancels the run when the orchestrator aborts the worker signal", async () => {
    const root = await createRoot();
    const close = vi.fn().mockResolvedValue(undefined);
    const controller = new AbortController();
    const runner = new AgentRunner({
      config: createConfig(root, "unused"),
      tracker: createTracker({
        refreshStates: [
          { id: "issue-1", identifier: "ABC-123", state: "In Progress" },
        ],
      }),
      createCodexClient: (input) =>
        createStubCodexClient([], input, {
          close,
          startSession: async ({
            prompt,
          }: {
            prompt: string;
            title: string;
          }) =>
            await new Promise((resolve, reject) => {
              const timeout = setTimeout(() => {
                resolve({
                  status: "completed" as const,
                  threadId: "thread-1",
                  turnId: "turn-1",
                  sessionId: "thread-1-turn-1",
                  usage: null,
                  rateLimits: null,
                  message: prompt,
                });
              }, 500);
              controller.signal.addEventListener(
                "abort",
                () => {
                  clearTimeout(timeout);
                  reject(new Error("Stopped due to terminal_state."));
                },
                { once: true },
              );
            }),
        }),
    });

    const pending = runner.run({
      issue: ISSUE_FIXTURE,
      attempt: null,
      signal: controller.signal,
    });
    controller.abort("Stopped due to terminal_state.");

    await expect(pending).rejects.toMatchObject({
      name: "AgentRunnerError",
      status: "canceled_by_reconciliation",
      failedPhase: "launching_agent_process",
      message: "Stopped due to terminal_state.",
    } satisfies Partial<AgentRunnerError>);
    expect(close).toHaveBeenCalled();
  });
});

function createStubCodexClient(
  prompts: string[],
  input: AgentRunnerCodexClientFactoryInput,
  overrides?: Partial<{
    close: ReturnType<typeof vi.fn>;
    statuses: Array<"completed" | "failed" | "cancelled">;
    messages: Array<string | null>;
    startSession: (input: { prompt: string; title: string }) => Promise<{
      status: "completed" | "failed" | "cancelled";
      threadId: string;
      turnId: string;
      sessionId: string;
      usage: {
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
      } | null;
      rateLimits: Record<string, unknown> | null;
      message: string | null;
    }>;
  }>,
) {
  let turn = 0;
  const statuses = overrides?.statuses ?? ["completed"];
  const messages = overrides?.messages;

  return {
    async startSession({ prompt, title }: { prompt: string; title: string }) {
      if (overrides?.startSession) {
        return overrides.startSession({ prompt, title });
      }

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
        message: messages
          ? (messages[turn - 1] ?? `turn ${turn}`)
          : `turn ${turn}`,
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
        message: messages
          ? (messages[turn - 1] ?? `turn ${turn}`)
          : `turn ${turn}`,
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
      maxRetryAttempts: 5,
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
