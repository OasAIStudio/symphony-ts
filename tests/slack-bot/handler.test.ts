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

import {
  createMessageHandler,
  splitAtParagraphs,
} from "../../src/slack-bot/handler.js";
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

// Helper to create a mock streamText return value with response promise
function createMockStreamResult(chunks: string[], sessionId?: string) {
  const messages = sessionId
    ? [{ providerMetadata: { "claude-code": { sessionId } } }]
    : [];
  return {
    textStream: createAsyncIterable(chunks),
    response: Promise.resolve({ messages }),
  } as unknown as ReturnType<typeof streamText>;
}

describe("createMessageHandler", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("calls streamText with claudeCode provider and correct cwd", async () => {
    const channelMap: ChannelProjectMap = new Map([
      ["C123", "/tmp/test-project"],
    ]);
    const sessions: SessionMap = new Map();
    const ccSessions = createCcSessionStore();
    const mockModel = { id: "mock-claude-code-model" };

    vi.mocked(claudeCode).mockReturnValue(
      mockModel as unknown as ReturnType<typeof claudeCode>,
    );
    vi.mocked(streamText).mockReturnValue(
      createMockStreamResult(["Hello from Claude"]),
    );

    const handler = createMessageHandler({
      channelMap,
      sessions,
      ccSessions,
      model: "sonnet",
    });

    const thread = createMockThread("C123");
    const message = createMockMessage("What files are in this project?");

    await handler(
      thread as unknown as Parameters<typeof handler>[0],
      message as unknown as Parameters<typeof handler>[1],
    );

    // Verify claudeCode was called with correct cwd and permissionMode
    expect(claudeCode).toHaveBeenCalledWith("sonnet", {
      cwd: "/tmp/test-project",
      permissionMode: "bypassPermissions",
    });

    // Verify streamText was called with the claudeCode model and prompt
    expect(streamText).toHaveBeenCalledWith({
      model: mockModel,
      prompt: "What files are in this project?",
    });
  });

  it("posts response as a thread reply via thread.post", async () => {
    const channelMap: ChannelProjectMap = new Map([
      ["C123", "/tmp/test-project"],
    ]);
    const sessions: SessionMap = new Map();
    const ccSessions = createCcSessionStore();
    const mockModel = { id: "mock-claude-code-model" };

    vi.mocked(claudeCode).mockReturnValue(
      mockModel as unknown as ReturnType<typeof claudeCode>,
    );
    vi.mocked(streamText).mockReturnValue(
      createMockStreamResult(["Here are the files"]),
    );

    const handler = createMessageHandler({ channelMap, sessions, ccSessions });

    const thread = createMockThread("C123");
    const message = createMockMessage("What files?");

    await handler(
      thread as unknown as Parameters<typeof handler>[0],
      message as unknown as Parameters<typeof handler>[1],
    );

    // Verify response was posted as a thread reply
    expect(thread.post).toHaveBeenCalledWith("Here are the files");
  });

  it("splits multi-paragraph responses into separate thread posts", async () => {
    const channelMap: ChannelProjectMap = new Map([
      ["C123", "/tmp/test-project"],
    ]);
    const sessions: SessionMap = new Map();
    const ccSessions = createCcSessionStore();
    const mockModel = { id: "mock-claude-code-model" };

    vi.mocked(claudeCode).mockReturnValue(
      mockModel as unknown as ReturnType<typeof claudeCode>,
    );
    vi.mocked(streamText).mockReturnValue(
      createMockStreamResult([
        "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.",
      ]),
    );

    const handler = createMessageHandler({ channelMap, sessions, ccSessions });

    const thread = createMockThread("C123");
    const message = createMockMessage("Tell me about files");

    await handler(
      thread as unknown as Parameters<typeof handler>[0],
      message as unknown as Parameters<typeof handler>[1],
    );

    expect(thread.post).toHaveBeenCalledTimes(3);
    expect(thread.post).toHaveBeenNthCalledWith(1, "First paragraph.");
    expect(thread.post).toHaveBeenNthCalledWith(2, "Second paragraph.");
    expect(thread.post).toHaveBeenNthCalledWith(3, "Third paragraph.");
  });

  it("uses bypassPermissions for all CC invocations", async () => {
    const channelMap: ChannelProjectMap = new Map([
      ["C123", "/tmp/test-project"],
    ]);
    const sessions: SessionMap = new Map();
    const ccSessions = createCcSessionStore();
    const mockModel = { id: "mock-claude-code-model" };

    vi.mocked(claudeCode).mockReturnValue(
      mockModel as unknown as ReturnType<typeof claudeCode>,
    );
    vi.mocked(streamText).mockReturnValue(createMockStreamResult(["OK"]));

    const handler = createMessageHandler({ channelMap, sessions, ccSessions });
    const thread = createMockThread("C123");
    const message = createMockMessage("test");

    await handler(
      thread as unknown as Parameters<typeof handler>[0],
      message as unknown as Parameters<typeof handler>[1],
    );

    expect(claudeCode).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ permissionMode: "bypassPermissions" }),
    );
  });

  it("posts warning when channel has no mapped project directory", async () => {
    const channelMap: ChannelProjectMap = new Map(); // empty
    const sessions: SessionMap = new Map();
    const ccSessions = createCcSessionStore();

    const handler = createMessageHandler({ channelMap, sessions, ccSessions });
    const thread = createMockThread("C999");
    const message = createMockMessage("hello");

    await handler(
      thread as unknown as Parameters<typeof handler>[0],
      message as unknown as Parameters<typeof handler>[1],
    );

    expect(thread.post).toHaveBeenCalledWith(
      expect.stringContaining("No project directory mapped"),
    );
    // Should still remove eyes and add warning
    expect(thread.adapter.removeReaction).toHaveBeenCalledWith(
      thread.id,
      message.id,
      "eyes",
    );
    expect(thread.adapter.addReaction).toHaveBeenCalledWith(
      thread.id,
      message.id,
      "warning",
    );
  });

  it("handles streamText errors by posting error message in thread", async () => {
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
            throw new Error("Claude Code failed");
          },
        };
      },
    };

    vi.mocked(streamText).mockReturnValue({
      textStream: failingStream,
      response: Promise.resolve({ messages: [] }),
    } as unknown as ReturnType<typeof streamText>);

    const handler = createMessageHandler({ channelMap, sessions, ccSessions });
    const thread = createMockThread("C123");
    const message = createMockMessage("test");

    await handler(
      thread as unknown as Parameters<typeof handler>[0],
      message as unknown as Parameters<typeof handler>[1],
    );

    // Should post error message
    expect(thread.post).toHaveBeenCalledWith("Error: Claude Code failed");
    // Should replace eyes with x
    expect(thread.adapter.removeReaction).toHaveBeenCalledWith(
      thread.id,
      message.id,
      "eyes",
    );
    expect(thread.adapter.addReaction).toHaveBeenCalledWith(
      thread.id,
      message.id,
      "x",
    );
  });

  it("tracks session state in the sessions map", async () => {
    const channelMap: ChannelProjectMap = new Map([
      ["C123", "/tmp/test-project"],
    ]);
    const sessions: SessionMap = new Map();
    const ccSessions = createCcSessionStore();
    const mockModel = { id: "mock-claude-code-model" };

    vi.mocked(claudeCode).mockReturnValue(
      mockModel as unknown as ReturnType<typeof claudeCode>,
    );
    vi.mocked(streamText).mockReturnValue(createMockStreamResult(["OK"]));

    const handler = createMessageHandler({ channelMap, sessions, ccSessions });
    const thread = createMockThread("C123");
    const message = createMockMessage("test");

    await handler(
      thread as unknown as Parameters<typeof handler>[0],
      message as unknown as Parameters<typeof handler>[1],
    );

    const session = sessions.get(thread.id);
    expect(session).toBeDefined();
    expect(session?.channelId).toBe("C123");
    expect(session?.projectDir).toBe("/tmp/test-project");
  });
});

describe("splitAtParagraphs", () => {
  it("splits text at double newlines", () => {
    expect(splitAtParagraphs("a\n\nb\n\nc")).toEqual(["a", "b", "c"]);
  });

  it("returns single element for text without paragraph breaks", () => {
    expect(splitAtParagraphs("single line")).toEqual(["single line"]);
  });

  it("handles multiple consecutive newlines", () => {
    expect(splitAtParagraphs("a\n\n\n\nb")).toEqual(["a", "b"]);
  });

  it("filters empty chunks", () => {
    expect(splitAtParagraphs("\n\na\n\n\n\nb\n\n")).toEqual(["a", "b"]);
  });
});
