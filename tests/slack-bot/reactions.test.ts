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

import { createMessageHandler } from "../../src/slack-bot/handler.js";
import { createCcSessionStore } from "../../src/slack-bot/session-store.js";
import type {
  ChannelProjectMap,
  SessionMap,
} from "../../src/slack-bot/types.js";

// Helper to create a mock thread
function createMockThread(channelId: string) {
  return {
    id: `slack:${channelId}:1234.5678`,
    channelId,
    adapter: {
      addReaction: vi.fn().mockResolvedValue(undefined),
      removeReaction: vi.fn().mockResolvedValue(undefined),
    },
    post: vi.fn().mockResolvedValue({ id: "sent-msg-1" }),
  };
}

// Helper to create a mock message
function createMockMessage(text: string) {
  return {
    id: "msg-ts-1234",
    text,
    threadId: "slack:C123:1234.5678",
    author: {
      userId: "U999",
      userName: "testuser",
      fullName: "Test User",
      isBot: false,
      isMe: false,
    },
    metadata: { dateSent: new Date(), edited: false },
    attachments: [],
    formatted: { type: "root" as const, children: [] },
    raw: {},
  };
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
    const thread = createMockThread("C123");
    const message = createMockMessage("test");

    await handler(
      thread as unknown as Parameters<typeof handler>[0],
      message as unknown as Parameters<typeof handler>[1],
    );

    // Verify eyes reaction was added first
    expect(thread.adapter.addReaction).toHaveBeenCalledWith(
      thread.id,
      message.id,
      "eyes",
    );
    // Eyes should be the first call to addReaction
    expect(thread.adapter.addReaction.mock.calls[0]).toEqual([
      thread.id,
      message.id,
      "eyes",
    ]);
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
    const thread = createMockThread("C123");
    const message = createMockMessage("test");

    await handler(
      thread as unknown as Parameters<typeof handler>[0],
      message as unknown as Parameters<typeof handler>[1],
    );

    // Verify eyes was removed
    expect(thread.adapter.removeReaction).toHaveBeenCalledWith(
      thread.id,
      message.id,
      "eyes",
    );

    // Verify white_check_mark was added
    expect(thread.adapter.addReaction).toHaveBeenCalledWith(
      thread.id,
      message.id,
      "white_check_mark",
    );

    // Verify order: eyes added → eyes removed → checkmark added
    const addCalls = thread.adapter.addReaction.mock.calls;
    const removeCalls = thread.adapter.removeReaction.mock.calls;

    expect(addCalls[0]?.[2]).toBe("eyes");
    expect(removeCalls[0]?.[2]).toBe("eyes");
    expect(addCalls[1]?.[2]).toBe("white_check_mark");
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
    const thread = createMockThread("C123");
    const message = createMockMessage("test");

    await handler(
      thread as unknown as Parameters<typeof handler>[0],
      message as unknown as Parameters<typeof handler>[1],
    );

    // Verify eyes was removed
    expect(thread.adapter.removeReaction).toHaveBeenCalledWith(
      thread.id,
      message.id,
      "eyes",
    );

    // Verify x was added (not white_check_mark)
    expect(thread.adapter.addReaction).toHaveBeenCalledWith(
      thread.id,
      message.id,
      "x",
    );

    // Verify white_check_mark was NOT added
    const addCalls = thread.adapter.addReaction.mock.calls;
    const checkmarkCalls = addCalls.filter(
      (call: unknown[]) => call[2] === "white_check_mark",
    );
    expect(checkmarkCalls).toHaveLength(0);
  });
});
