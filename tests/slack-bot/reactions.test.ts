import { afterEach, describe, expect, it, vi } from "vitest";

// Mock the AI SDK modules before importing handler
vi.mock("ai", () => ({
  streamText: vi.fn(),
}));

vi.mock("ai-sdk-provider-claude-code", () => ({
  claudeCode: vi.fn(),
}));

import { streamText } from "ai";
import { claudeCode } from "ai-sdk-provider-claude-code";

import type { BoltMessageArgs } from "../../src/slack-bot/handler.js";
import { createMessageHandler } from "../../src/slack-bot/handler.js";
import { createCcSessionStore } from "../../src/slack-bot/session-store.js";
import type {
  ChannelProjectMap,
  SessionMap,
} from "../../src/slack-bot/types.js";

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
  };

  const message = {
    type: "message" as const,
    text,
    ts: "1234.5678",
    channel: channelId,
  };

  const args = {
    message,
    say,
    client,
    context: {},
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    next: vi.fn(),
    event: message,
    payload: message,
    body: { event: message },
  } as unknown as BoltMessageArgs;

  return { args, say, client };
}

// Helper to create an async iterable from strings
async function* createAsyncIterable(chunks: string[]): AsyncIterable<string> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

describe("Reaction lifecycle", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("adds eyes reaction on message receipt", async () => {
    const channelMap: ChannelProjectMap = new Map([
      ["C123", "/tmp/test-project"],
    ]);
    const sessions: SessionMap = new Map();
    const mockModel = { id: "mock-claude-code-model" };

    vi.mocked(claudeCode).mockReturnValue(
      mockModel as unknown as ReturnType<typeof claudeCode>,
    );
    vi.mocked(streamText).mockReturnValue({
      textStream: createAsyncIterable(["response"]),
      response: Promise.resolve({ messages: [] }),
    } as unknown as ReturnType<typeof streamText>);

    const handler = createMessageHandler({
      channelMap,
      sessions,
      ccSessions: createCcSessionStore(),
    });
    const { args, client } = createMockBoltArgs("C123", "test");

    await handler(args);

    // Verify eyes reaction was added first
    expect(client.reactions.add).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "C123",
        timestamp: "1234.5678",
        name: "eyes",
      }),
    );
    // Eyes should be the first call to addReaction
    expect(client.reactions.add.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({ name: "eyes" }),
    );
  });

  it("replaces eyes with white_check_mark on successful completion", async () => {
    const channelMap: ChannelProjectMap = new Map([
      ["C123", "/tmp/test-project"],
    ]);
    const sessions: SessionMap = new Map();
    const mockModel = { id: "mock-claude-code-model" };

    vi.mocked(claudeCode).mockReturnValue(
      mockModel as unknown as ReturnType<typeof claudeCode>,
    );
    vi.mocked(streamText).mockReturnValue({
      textStream: createAsyncIterable(["response"]),
      response: Promise.resolve({ messages: [] }),
    } as unknown as ReturnType<typeof streamText>);

    const handler = createMessageHandler({
      channelMap,
      sessions,
      ccSessions: createCcSessionStore(),
    });
    const { args, client } = createMockBoltArgs("C123", "test");

    await handler(args);

    // Verify eyes was removed
    expect(client.reactions.remove).toHaveBeenCalledWith(
      expect.objectContaining({ name: "eyes" }),
    );

    // Verify white_check_mark was added
    expect(client.reactions.add).toHaveBeenCalledWith(
      expect.objectContaining({ name: "white_check_mark" }),
    );

    // Verify order: eyes added → eyes removed → checkmark added
    const addCalls = client.reactions.add.mock.calls;
    const removeCalls = client.reactions.remove.mock.calls;

    expect(addCalls[0]?.[0]?.name).toBe("eyes");
    expect(removeCalls[0]?.[0]?.name).toBe("eyes");
    expect(addCalls[1]?.[0]?.name).toBe("white_check_mark");
  });

  it("replaces eyes with x reaction on error", async () => {
    const channelMap: ChannelProjectMap = new Map([
      ["C123", "/tmp/test-project"],
    ]);
    const sessions: SessionMap = new Map();
    const mockModel = { id: "mock-claude-code-model" };

    vi.mocked(claudeCode).mockReturnValue(
      mockModel as unknown as ReturnType<typeof claudeCode>,
    );

    // Create a failing async iterable (plain object to avoid lint/useYield)
    const failingStream: AsyncIterable<string> = {
      [Symbol.asyncIterator]() {
        return {
          async next(): Promise<IteratorResult<string>> {
            throw new Error("CC error");
          },
        };
      },
    };

    vi.mocked(streamText).mockReturnValue({
      textStream: failingStream,
      response: Promise.resolve({ messages: [] }),
    } as unknown as ReturnType<typeof streamText>);

    const handler = createMessageHandler({
      channelMap,
      sessions,
      ccSessions: createCcSessionStore(),
    });
    const { args, client } = createMockBoltArgs("C123", "test");

    await handler(args);

    // Verify eyes was removed
    expect(client.reactions.remove).toHaveBeenCalledWith(
      expect.objectContaining({ name: "eyes" }),
    );

    // Verify x was added (not white_check_mark)
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
});
