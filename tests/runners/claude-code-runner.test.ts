import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { CodexClientEvent } from "../../src/codex/app-server-client.js";
import {
  ClaudeCodeRunner,
  resolveClaudeModelId,
} from "../../src/runners/claude-code-runner.js";

// Mock the AI SDK generateText
vi.mock("ai", () => ({
  generateText: vi.fn(),
}));

vi.mock("ai-sdk-provider-claude-code", () => ({
  claudeCode: vi.fn(() => "mock-claude-model"),
}));

// Mock node:fs for heartbeat tests
vi.mock("node:fs", () => ({
  statSync: vi.fn(() => ({ mtimeMs: 1000 })),
}));

import { statSync } from "node:fs";
import { generateText } from "ai";
import { claudeCode } from "ai-sdk-provider-claude-code";

const mockGenerateText = vi.mocked(generateText);
const mockClaudeCode = vi.mocked(claudeCode);
const mockStatSync = vi.mocked(statSync);

describe("ClaudeCodeRunner", () => {
  it("implements AgentRunnerCodexClient interface (startSession, continueTurn, close)", () => {
    const runner = new ClaudeCodeRunner({
      cwd: "/tmp/workspace",
      model: "sonnet",
    });

    expect(typeof runner.startSession).toBe("function");
    expect(typeof runner.continueTurn).toBe("function");
    expect(typeof runner.close).toBe("function");
  });

  it("calls generateText with claude-code model on startSession", async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: "Hello from Claude",
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokenDetails: {
          textTokens: undefined,
          reasoningTokens: undefined,
        },
      },
    } as never);

    const runner = new ClaudeCodeRunner({
      cwd: "/tmp/workspace",
      model: "opus",
    });

    const result = await runner.startSession({
      prompt: "Fix the bug",
      title: "ABC-123: Fix the bug",
    });

    expect(mockClaudeCode).toHaveBeenCalledWith("opus", {
      cwd: "/tmp/workspace",
      permissionMode: "bypassPermissions",
    });
    expect(mockGenerateText).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "mock-claude-model",
        prompt: "Fix the bug",
      }),
    );
    expect(result.status).toBe("completed");
    expect(result.message).toBe("Hello from Claude");
    expect(result.usage).toEqual({
      inputTokens: 100,
      outputTokens: 50,
      totalTokens: 150,
    });
  });

  it("emits session_started and turn_completed events", async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: "Done",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokenDetails: {
          textTokens: undefined,
          reasoningTokens: undefined,
        },
      },
    } as never);

    const events: CodexClientEvent[] = [];
    const runner = new ClaudeCodeRunner({
      cwd: "/tmp/workspace",
      model: "sonnet",
      onEvent: (event) => events.push(event),
    });

    await runner.startSession({ prompt: "test", title: "test" });

    expect(events).toHaveLength(2);
    expect(events[0]!.event).toBe("session_started");
    expect(events[0]!.codexAppServerPid).toBeNull();
    expect(events[1]!.event).toBe("turn_completed");
    expect(events[1]!.usage).toEqual({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
    });
  });

  it("emits turn_failed on error and returns failed status", async () => {
    mockGenerateText.mockRejectedValueOnce(new Error("Rate limit exceeded"));

    const events: CodexClientEvent[] = [];
    const runner = new ClaudeCodeRunner({
      cwd: "/tmp/workspace",
      model: "sonnet",
      onEvent: (event) => events.push(event),
    });

    const result = await runner.startSession({
      prompt: "test",
      title: "test",
    });

    expect(result.status).toBe("failed");
    expect(result.message).toBe("Rate limit exceeded");
    expect(result.usage).toBeNull();
    expect(events.map((e) => e.event)).toEqual([
      "session_started",
      "turn_failed",
    ]);
  });

  it("increments turn count across startSession and continueTurn", async () => {
    const mockResult = {
      text: "ok",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokenDetails: {
          textTokens: undefined,
          reasoningTokens: undefined,
        },
      },
    } as never;
    mockGenerateText
      .mockResolvedValueOnce(mockResult)
      .mockResolvedValueOnce(mockResult);

    const runner = new ClaudeCodeRunner({
      cwd: "/tmp/workspace",
      model: "sonnet",
    });

    const first = await runner.startSession({ prompt: "p1", title: "t" });
    const second = await runner.continueTurn("p2", "t");

    expect(first.turnId).toBe("turn-1");
    expect(second.turnId).toBe("turn-2");
    // Session IDs share the same thread
    expect(first.threadId).toBe(second.threadId);
  });

  it("handles undefined token values from AI SDK gracefully", async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: "result",
      usage: {
        inputTokens: undefined,
        outputTokens: undefined,
        totalTokens: undefined,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokenDetails: {
          textTokens: undefined,
          reasoningTokens: undefined,
        },
      },
    } as never);

    const runner = new ClaudeCodeRunner({
      cwd: "/tmp/workspace",
      model: "sonnet",
    });

    const result = await runner.startSession({ prompt: "p", title: "t" });
    expect(result.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
    // detail fields should be absent (not 0) when provider doesn't report them
    expect(result.usage?.cacheReadTokens).toBeUndefined();
    expect(result.usage?.cacheWriteTokens).toBeUndefined();
    expect(result.usage?.noCacheTokens).toBeUndefined();
    expect(result.usage?.reasoningTokens).toBeUndefined();
  });

  it("extracts cache and reasoning token details from inputTokenDetails / outputTokenDetails", async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: "result",
      usage: {
        inputTokens: 100,
        outputTokens: 50,
        totalTokens: 150,
        inputTokenDetails: {
          cacheReadTokens: 20,
          cacheWriteTokens: 10,
          noCacheTokens: 70,
        },
        outputTokenDetails: {
          textTokens: 40,
          reasoningTokens: 10,
        },
      },
    } as never);

    const runner = new ClaudeCodeRunner({
      cwd: "/tmp/workspace",
      model: "sonnet",
    });

    const result = await runner.startSession({ prompt: "p", title: "t" });
    expect(result.usage?.cacheReadTokens).toBe(20);
    expect(result.usage?.cacheWriteTokens).toBe(10);
    expect(result.usage?.noCacheTokens).toBe(70);
    expect(result.usage?.reasoningTokens).toBe(10);
  });

  it("maps full Anthropic model IDs to short provider names", async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: "ok",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokenDetails: {
          textTokens: undefined,
          reasoningTokens: undefined,
        },
      },
    } as never);

    const runner = new ClaudeCodeRunner({
      cwd: "/tmp/workspace",
      model: "claude-sonnet-4-5",
    });

    await runner.startSession({ prompt: "test", title: "test" });

    // Should resolve "claude-sonnet-4-5" → "sonnet"
    expect(mockClaudeCode).toHaveBeenCalledWith("sonnet", {
      cwd: "/tmp/workspace",
      permissionMode: "bypassPermissions",
    });
  });

  it("passes abortSignal to generateText for subprocess cleanup", async () => {
    mockGenerateText.mockResolvedValueOnce({
      text: "ok",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        totalTokens: 15,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokenDetails: {
          textTokens: undefined,
          reasoningTokens: undefined,
        },
      },
    } as never);

    const runner = new ClaudeCodeRunner({
      cwd: "/tmp/workspace",
      model: "sonnet",
    });

    await runner.startSession({ prompt: "test", title: "test" });

    const callArgs = mockGenerateText.mock.calls[0]![0]!;
    expect(callArgs).toHaveProperty("abortSignal");
    expect(callArgs.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it("aborts in-flight turn when close() is called", async () => {
    // Create a controllable promise to simulate a long-running turn
    let rejectFn: (reason: unknown) => void;
    mockGenerateText.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectFn = reject;
      }) as never,
    );

    const runner = new ClaudeCodeRunner({
      cwd: "/tmp/workspace",
      model: "sonnet",
    });

    // Start a turn but don't await — the async function runs synchronously
    // up to the first await (generateText), setting activeTurnController
    const turnPromise = runner.startSession({
      prompt: "long task",
      title: "test",
    });

    // The activeTurnController should be set synchronously before the await
    // Access the private field to get the controller directly
    const controller = (
      runner as unknown as { activeTurnController: AbortController | null }
    ).activeTurnController;
    expect(controller).not.toBeNull();
    expect(controller!.signal.aborted).toBe(false);

    // Close the runner — should abort the in-flight controller
    await runner.close();
    expect(controller!.signal.aborted).toBe(true);

    // Reject the mock so the turn settles
    rejectFn!(new Error("aborted"));
    const result = await turnPromise;
    expect(result.status).toBe("failed");
  });
});

describe("ClaudeCodeRunner heartbeat", () => {
  // Path-aware mtime tracking for heartbeat tests.
  // The heartbeat polls both .git/index and the workspace root dir.
  let mtimeByPath: Record<string, number>;

  beforeEach(() => {
    vi.useFakeTimers();
    mtimeByPath = {
      "/tmp/workspace/.git/index": 1000,
      "/tmp/workspace": 1000,
    };
    mockStatSync.mockImplementation((p: unknown) => {
      const key = String(p);
      return { mtimeMs: mtimeByPath[key] ?? 0 } as never;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits activity_heartbeat when git index mtime changes during execution", async () => {
    let resolveFn: (value: unknown) => void;
    mockGenerateText.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFn = resolve;
      }) as never,
    );

    const events: CodexClientEvent[] = [];
    const runner = new ClaudeCodeRunner({
      cwd: "/tmp/workspace",
      model: "sonnet",
      onEvent: (event) => events.push(event),
      heartbeatIntervalMs: 5000,
    });

    const turnPromise = runner.startSession({
      prompt: "long task",
      title: "test",
    });

    // Initial poll — no change, no heartbeat
    vi.advanceTimersByTime(5000);
    expect(events.filter((e) => e.event === "activity_heartbeat")).toHaveLength(
      0,
    );

    // Simulate a git index change (only git, not workspace dir)
    mtimeByPath["/tmp/workspace/.git/index"] = 2000;
    vi.advanceTimersByTime(5000);
    const heartbeats = events.filter((e) => e.event === "activity_heartbeat");
    expect(heartbeats).toHaveLength(1);
    expect(heartbeats[0]!.message).toBe(
      "workspace file change detected (git index)",
    );

    // Resolve the turn
    resolveFn!({
      text: "done",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
    await turnPromise;
  });

  it("emits activity_heartbeat when workspace dir mtime changes (non-git activity)", async () => {
    let resolveFn: (value: unknown) => void;
    mockGenerateText.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFn = resolve;
      }) as never,
    );

    const events: CodexClientEvent[] = [];
    const runner = new ClaudeCodeRunner({
      cwd: "/tmp/workspace",
      model: "sonnet",
      onEvent: (event) => events.push(event),
      heartbeatIntervalMs: 5000,
    });

    const turnPromise = runner.startSession({
      prompt: "review task",
      title: "test",
    });

    // Initial poll — no change
    vi.advanceTimersByTime(5000);
    expect(events.filter((e) => e.event === "activity_heartbeat")).toHaveLength(
      0,
    );

    // Simulate workspace dir change only (e.g. review agent creating temp file)
    mtimeByPath["/tmp/workspace"] = 2000;
    vi.advanceTimersByTime(5000);
    const heartbeats = events.filter((e) => e.event === "activity_heartbeat");
    expect(heartbeats).toHaveLength(1);
    expect(heartbeats[0]!.message).toBe(
      "workspace file change detected (workspace dir)",
    );

    resolveFn!({
      text: "done",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
    await turnPromise;
  });

  it("emits heartbeat indicating both sources when both change simultaneously", async () => {
    let resolveFn: (value: unknown) => void;
    mockGenerateText.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFn = resolve;
      }) as never,
    );

    const events: CodexClientEvent[] = [];
    const runner = new ClaudeCodeRunner({
      cwd: "/tmp/workspace",
      model: "sonnet",
      onEvent: (event) => events.push(event),
      heartbeatIntervalMs: 5000,
    });

    const turnPromise = runner.startSession({ prompt: "task", title: "test" });

    // Both change at same interval
    mtimeByPath["/tmp/workspace/.git/index"] = 2000;
    mtimeByPath["/tmp/workspace"] = 2000;
    vi.advanceTimersByTime(5000);
    const heartbeats = events.filter((e) => e.event === "activity_heartbeat");
    expect(heartbeats).toHaveLength(1);
    expect(heartbeats[0]!.message).toBe(
      "workspace file change detected (git index and workspace dir)",
    );

    resolveFn!({
      text: "done",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
    await turnPromise;
  });

  it("does not emit heartbeat when neither mtime changes", async () => {
    let resolveFn: (value: unknown) => void;
    mockGenerateText.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFn = resolve;
      }) as never,
    );

    const events: CodexClientEvent[] = [];
    const runner = new ClaudeCodeRunner({
      cwd: "/tmp/workspace",
      model: "sonnet",
      onEvent: (event) => events.push(event),
      heartbeatIntervalMs: 5000,
    });

    const turnPromise = runner.startSession({ prompt: "task", title: "test" });

    // Advance through multiple intervals with no mtime change
    vi.advanceTimersByTime(20000);
    expect(events.filter((e) => e.event === "activity_heartbeat")).toHaveLength(
      0,
    );

    resolveFn!({
      text: "done",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
    await turnPromise;
  });

  it("clears heartbeat timer after turn completes", async () => {
    let resolveFn: (value: unknown) => void;
    mockGenerateText.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFn = resolve;
      }) as never,
    );

    const events: CodexClientEvent[] = [];
    const runner = new ClaudeCodeRunner({
      cwd: "/tmp/workspace",
      model: "sonnet",
      onEvent: (event) => events.push(event),
      heartbeatIntervalMs: 5000,
    });

    const turnPromise = runner.startSession({ prompt: "task", title: "test" });

    resolveFn!({
      text: "done",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
    await turnPromise;

    // After turn completes, simulate file changes — should NOT emit heartbeats
    mtimeByPath["/tmp/workspace/.git/index"] = 9999;
    mtimeByPath["/tmp/workspace"] = 9999;
    vi.advanceTimersByTime(10000);
    expect(events.filter((e) => e.event === "activity_heartbeat")).toHaveLength(
      0,
    );
  });

  it("does not start heartbeat when heartbeatIntervalMs is 0", async () => {
    let resolveFn: (value: unknown) => void;
    mockGenerateText.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFn = resolve;
      }) as never,
    );

    const events: CodexClientEvent[] = [];
    const runner = new ClaudeCodeRunner({
      cwd: "/tmp/workspace",
      model: "sonnet",
      onEvent: (event) => events.push(event),
      heartbeatIntervalMs: 0,
    });

    const turnPromise = runner.startSession({ prompt: "task", title: "test" });

    mtimeByPath["/tmp/workspace/.git/index"] = 9999;
    mtimeByPath["/tmp/workspace"] = 9999;
    vi.advanceTimersByTime(20000);
    expect(events.filter((e) => e.event === "activity_heartbeat")).toHaveLength(
      0,
    );

    resolveFn!({
      text: "done",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
    await turnPromise;
  });

  it("emits multiple heartbeats for successive file changes", async () => {
    let resolveFn: (value: unknown) => void;
    mockGenerateText.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFn = resolve;
      }) as never,
    );

    const events: CodexClientEvent[] = [];
    const runner = new ClaudeCodeRunner({
      cwd: "/tmp/workspace",
      model: "sonnet",
      onEvent: (event) => events.push(event),
      heartbeatIntervalMs: 5000,
    });

    const turnPromise = runner.startSession({ prompt: "task", title: "test" });

    // First change — git index only
    mtimeByPath["/tmp/workspace/.git/index"] = 2000;
    vi.advanceTimersByTime(5000);

    // Second change — workspace dir only
    mtimeByPath["/tmp/workspace"] = 3000;
    vi.advanceTimersByTime(5000);

    // No change on third tick
    vi.advanceTimersByTime(5000);

    expect(events.filter((e) => e.event === "activity_heartbeat")).toHaveLength(
      2,
    );

    resolveFn!({
      text: "done",
      usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
    });
    await turnPromise;
  });
});

describe("resolveClaudeModelId", () => {
  it("maps claude-opus-4 to opus", () => {
    expect(resolveClaudeModelId("claude-opus-4")).toBe("opus");
  });

  it("maps claude-opus-4-6 to opus", () => {
    expect(resolveClaudeModelId("claude-opus-4-6")).toBe("opus");
  });

  it("maps claude-sonnet-4-5 to sonnet", () => {
    expect(resolveClaudeModelId("claude-sonnet-4-5")).toBe("sonnet");
  });

  it("maps claude-haiku-4-5 to haiku", () => {
    expect(resolveClaudeModelId("claude-haiku-4-5")).toBe("haiku");
  });

  it("passes through already-short names unchanged", () => {
    expect(resolveClaudeModelId("opus")).toBe("opus");
    expect(resolveClaudeModelId("sonnet")).toBe("sonnet");
    expect(resolveClaudeModelId("haiku")).toBe("haiku");
  });

  it("passes through unknown model names unchanged", () => {
    expect(resolveClaudeModelId("custom-model")).toBe("custom-model");
  });
});
