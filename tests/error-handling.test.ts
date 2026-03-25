import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the AI SDK modules before importing handler
vi.mock("ai", () => ({
  streamText: vi.fn(),
}));

vi.mock("ai-sdk-provider-claude-code", () => ({
  claudeCode: vi.fn(),
}));

vi.mock("../src/slack-bot/stream-consumer.js", () => ({
  StreamConsumer: vi.fn().mockImplementation(() => ({
    append: vi.fn().mockResolvedValue(undefined),
    finish: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { streamText } from "ai";
import { claudeCode } from "ai-sdk-provider-claude-code";

import type { BoltMessageArgs } from "../src/slack-bot/handler.js";
import { createMessageHandler } from "../src/slack-bot/handler.js";
import { createCcSessionStore } from "../src/slack-bot/session-store.js";
import { StreamConsumer } from "../src/slack-bot/stream-consumer.js";
import type { ChannelProjectMap, SessionMap } from "../src/slack-bot/types.js";

/** Create a mock Bolt message args object. */
function createMockBoltArgs(
  channelId: string,
  text: string,
): {
  args: BoltMessageArgs;
  say: ReturnType<typeof vi.fn>;
  client: {
    reactions: {
      add: ReturnType<typeof vi.fn>;
      remove: ReturnType<typeof vi.fn>;
    };
  };
} {
  const say = vi.fn().mockResolvedValue(undefined);
  const client = {
    reactions: {
      add: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    },
    assistant: {
      threads: {
        setStatus: vi.fn().mockResolvedValue(undefined),
      },
    },
  };

  const message = {
    type: "message" as const,
    text,
    ts: "1234.5678",
    channel: channelId,
    user: "U_TEST_USER",
  };

  const args = {
    message,
    say,
    client,
    context: { teamId: "T_TEST_TEAM" },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    next: vi.fn(),
    event: message,
    payload: message,
    body: { event: message },
  } as unknown as BoltMessageArgs;

  return { args, say, client };
}

describe("Error handling", () => {
  beforeEach(() => {
    vi.mocked(StreamConsumer).mockImplementation(
      () =>
        ({
          append: vi.fn().mockResolvedValue(undefined),
          finish: vi.fn().mockResolvedValue(undefined),
        }) as unknown as StreamConsumer,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("posts a user-friendly error message to the thread when streamText throws", async () => {
    const channelMap: ChannelProjectMap = new Map([
      ["C123", "/tmp/test-project"],
    ]);
    const sessions: SessionMap = new Map();
    const ccSessions = createCcSessionStore();
    const mockModel = { id: "mock-claude-code-model" };

    vi.mocked(claudeCode).mockReturnValue(
      mockModel as unknown as ReturnType<typeof claudeCode>,
    );

    // Create a failing async iterable (plain object to avoid lint/useYield)
    const failingStream: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<string>> {
            throw new Error("Rate limit exceeded");
          },
        };
      },
    };

    vi.mocked(streamText).mockReturnValue({
      textStream: failingStream,
      response: Promise.resolve({ messages: [] }),
    } as unknown as ReturnType<typeof streamText>);

    const handler = createMessageHandler({ channelMap, sessions, ccSessions });
    const { args, say } = createMockBoltArgs("C123", "test query");
    await handler(args);

    // Should post a structured error message
    expect(say).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Rate limit exceeded"),
      }),
    );
  });

  it("adds an x reaction instead of checkmark on error", async () => {
    const channelMap: ChannelProjectMap = new Map([
      ["C123", "/tmp/test-project"],
    ]);
    const sessions: SessionMap = new Map();
    const ccSessions = createCcSessionStore();
    const mockModel = { id: "mock-claude-code-model" };

    vi.mocked(claudeCode).mockReturnValue(
      mockModel as unknown as ReturnType<typeof claudeCode>,
    );

    const failingStream: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<string>> {
            throw new Error("Session failure");
          },
        };
      },
    };

    vi.mocked(streamText).mockReturnValue({
      textStream: failingStream,
      response: Promise.resolve({ messages: [] }),
    } as unknown as ReturnType<typeof streamText>);

    const handler = createMessageHandler({ channelMap, sessions, ccSessions });
    const { args, client } = createMockBoltArgs("C123", "test");
    await handler(args);

    // Verify reactions.remove('eyes') was called
    expect(client.reactions.remove).toHaveBeenCalledWith(
      expect.objectContaining({ name: "eyes" }),
    );

    // Verify reactions.add('x') was called
    expect(client.reactions.add).toHaveBeenCalledWith(
      expect.objectContaining({ name: "x" }),
    );

    // Verify white_check_mark was NOT added
    const addCalls = client.reactions.add.mock.calls;
    const checkmarkCalls = addCalls.filter(
      (call: unknown[]) =>
        (call[0] as Record<string, unknown>)?.name === "white_check_mark",
    );
    expect(checkmarkCalls).toHaveLength(0);
  });

  it("handles non-Error thrown values with a generic message", async () => {
    const channelMap: ChannelProjectMap = new Map([
      ["C123", "/tmp/test-project"],
    ]);
    const sessions: SessionMap = new Map();
    const ccSessions = createCcSessionStore();
    const mockModel = { id: "mock-claude-code-model" };

    vi.mocked(claudeCode).mockReturnValue(
      mockModel as unknown as ReturnType<typeof claudeCode>,
    );

    const failingStream: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<string>> {
            throw "string error"; // eslint-disable-line no-throw-literal
          },
        };
      },
    };

    vi.mocked(streamText).mockReturnValue({
      textStream: failingStream,
      response: Promise.resolve({ messages: [] }),
    } as unknown as ReturnType<typeof streamText>);

    const handler = createMessageHandler({ channelMap, sessions, ccSessions });
    const { args, say, client } = createMockBoltArgs("C123", "test");
    await handler(args);

    // Should post generic error message for non-Error values
    expect(say).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("An unexpected error occurred"),
      }),
    );

    // Should still add x reaction
    expect(client.reactions.add).toHaveBeenCalledWith(
      expect.objectContaining({ name: "x" }),
    );
  });
});
