import { describe, expect, it, vi } from "vitest";

import type { CodexClientEvent } from "../../src/codex/app-server-client.js";
import { GeminiRunner } from "../../src/runners/gemini-runner.js";

const mockModel = vi.fn();

vi.mock("ai", () => ({
  generateText: vi.fn(),
}));

vi.mock("ai-sdk-provider-gemini-cli", () => ({
  createGeminiProvider: vi.fn(() => mockModel),
}));

import { generateText } from "ai";

const mockGenerateText = vi.mocked(generateText);

describe("GeminiRunner", () => {
  it("implements AgentRunnerCodexClient interface", () => {
    const runner = new GeminiRunner({
      cwd: "/tmp/workspace",
      model: "gemini-2.5-pro",
    });

    expect(typeof runner.startSession).toBe("function");
    expect(typeof runner.continueTurn).toBe("function");
    expect(typeof runner.close).toBe("function");
  });

  it("calls generateText with gemini model on startSession", async () => {
    mockModel.mockReturnValue("mock-gemini-model");
    mockGenerateText.mockResolvedValueOnce({
      text: "Hello from Gemini",
      usage: {
        inputTokens: 200,
        outputTokens: 100,
        totalTokens: 300,
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

    const runner = new GeminiRunner({
      cwd: "/tmp/workspace",
      model: "gemini-2.5-pro",
    });

    const result = await runner.startSession({
      prompt: "Review the code",
      title: "ABC-123: Review",
    });

    expect(mockModel).toHaveBeenCalledWith("gemini-2.5-pro");
    expect(mockGenerateText).toHaveBeenCalledWith({
      model: "mock-gemini-model",
      prompt: "Review the code",
    });
    expect(result.status).toBe("completed");
    expect(result.message).toBe("Hello from Gemini");
    expect(result.usage).toEqual({
      inputTokens: 200,
      outputTokens: 100,
      totalTokens: 300,
    });
  });

  it("emits session_started and turn_completed events", async () => {
    mockModel.mockReturnValue("mock-gemini-model");
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
    const runner = new GeminiRunner({
      cwd: "/tmp/workspace",
      model: "gemini-2.5-pro",
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

  it("emits turn_failed on error", async () => {
    mockModel.mockReturnValue("mock-gemini-model");
    mockGenerateText.mockRejectedValueOnce(new Error("Gemini unavailable"));

    const events: CodexClientEvent[] = [];
    const runner = new GeminiRunner({
      cwd: "/tmp/workspace",
      model: "gemini-2.5-pro",
      onEvent: (event) => events.push(event),
    });

    const result = await runner.startSession({
      prompt: "test",
      title: "test",
    });

    expect(result.status).toBe("failed");
    expect(result.message).toBe("Gemini unavailable");
    expect(events.map((e) => e.event)).toEqual([
      "session_started",
      "turn_failed",
    ]);
  });

  it("increments turn count across calls", async () => {
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
    mockModel.mockReturnValue("mock-gemini-model");
    mockGenerateText
      .mockResolvedValueOnce(mockResult)
      .mockResolvedValueOnce(mockResult);

    const runner = new GeminiRunner({
      cwd: "/tmp/workspace",
      model: "gemini-2.5-pro",
    });

    const first = await runner.startSession({ prompt: "p1", title: "t" });
    const second = await runner.continueTurn("p2", "t");

    expect(first.turnId).toBe("turn-1");
    expect(second.turnId).toBe("turn-2");
    expect(first.threadId).toBe(second.threadId);
  });
});
