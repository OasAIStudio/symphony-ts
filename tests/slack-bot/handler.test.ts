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
  type BoltMessageArgs,
  createMessageHandler,
  splitAtParagraphs,
} from "../../src/slack-bot/handler.js";
import { createCcSessionStore } from "../../src/slack-bot/session-store.js";
import type {
  ChannelProjectMap,
  SessionMap,
} from "../../src/slack-bot/types.js";

/** Create a mock Bolt message args object. */
function createMockBoltArgs(
  channelId: string,
  text: string,
  overrides?: Partial<{
    ts: string;
    thread_ts: string;
    bot_id: string;
    subtype: string;
  }>,
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

  const message: Record<string, unknown> = {
    type: "message" as const,
    text,
    ts: overrides?.ts ?? "1234.5678",
    channel: channelId,
  };
  if (overrides?.thread_ts) {
    message.thread_ts = overrides.thread_ts;
  }
  if (overrides?.bot_id) {
    message.bot_id = overrides.bot_id;
  }
  if (overrides?.subtype) {
    message.subtype = overrides.subtype;
  }

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

    const { args } = createMockBoltArgs(
      "C123",
      "What files are in this project?",
    );
    await handler(args);

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

  it("posts response as a threaded reply via say()", async () => {
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

    const { args, say } = createMockBoltArgs("C123", "What files?");
    await handler(args);

    // Verify response was posted as a thread reply
    expect(say).toHaveBeenCalledWith({
      text: "Here are the files",
      thread_ts: "1234.5678",
    });
  });

  it("splits multi-paragraph responses into separate thread posts when they exceed chunk limit", async () => {
    const channelMap: ChannelProjectMap = new Map([
      ["C123", "/tmp/test-project"],
    ]);
    const sessions: SessionMap = new Map();
    const ccSessions = createCcSessionStore();
    const mockModel = { id: "mock-claude-code-model" };

    vi.mocked(claudeCode).mockReturnValue(
      mockModel as unknown as ReturnType<typeof claudeCode>,
    );

    // Small paragraphs that fit in a single chunk are posted together
    vi.mocked(streamText).mockReturnValue(
      createMockStreamResult([
        "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.",
      ]),
    );

    const handler = createMessageHandler({ channelMap, sessions, ccSessions });

    const { args, say } = createMockBoltArgs("C123", "Tell me about files");
    await handler(args);

    // Small paragraphs are combined into a single chunk (under 39K limit)
    expect(say).toHaveBeenCalledTimes(1);
    expect(say).toHaveBeenCalledWith({
      text: "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.",
      thread_ts: "1234.5678",
    });
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
    const { args } = createMockBoltArgs("C123", "test");
    await handler(args);

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
    const { args, say, client } = createMockBoltArgs("C999", "hello");
    await handler(args);

    expect(say).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("No project directory mapped"),
      }),
    );
    // Should still remove eyes and add warning
    expect(client.reactions.remove).toHaveBeenCalledWith(
      expect.objectContaining({ name: "eyes" }),
    );
    expect(client.reactions.add).toHaveBeenCalledWith(
      expect.objectContaining({ name: "warning" }),
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
    const { args, say, client } = createMockBoltArgs("C123", "test");
    await handler(args);

    // Should post error message
    expect(say).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "Error: Claude Code failed",
      }),
    );
    // Should replace eyes with x
    expect(client.reactions.remove).toHaveBeenCalledWith(
      expect.objectContaining({ name: "eyes" }),
    );
    expect(client.reactions.add).toHaveBeenCalledWith(
      expect.objectContaining({ name: "x" }),
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
    const { args } = createMockBoltArgs("C123", "test");
    await handler(args);

    // Thread ID = message.thread_ts || message.ts = "1234.5678"
    const session = sessions.get("1234.5678");
    expect(session).toBeDefined();
    expect(session?.channelId).toBe("C123");
    expect(session?.projectDir).toBe("/tmp/test-project");
  });

  it("skips messages with bot_id", async () => {
    const channelMap: ChannelProjectMap = new Map([
      ["C123", "/tmp/test-project"],
    ]);
    const sessions: SessionMap = new Map();
    const ccSessions = createCcSessionStore();

    const handler = createMessageHandler({ channelMap, sessions, ccSessions });
    const { args, say } = createMockBoltArgs("C123", "bot message", {
      bot_id: "B123",
    });
    await handler(args);

    expect(say).not.toHaveBeenCalled();
  });

  it("skips messages with subtype message_changed", async () => {
    const channelMap: ChannelProjectMap = new Map([
      ["C123", "/tmp/test-project"],
    ]);
    const sessions: SessionMap = new Map();
    const ccSessions = createCcSessionStore();

    const handler = createMessageHandler({ channelMap, sessions, ccSessions });
    const { args, say } = createMockBoltArgs("C123", "edited", {
      subtype: "message_changed",
    });
    await handler(args);

    expect(say).not.toHaveBeenCalled();
  });

  it("skips messages with subtype message_deleted", async () => {
    const channelMap: ChannelProjectMap = new Map([
      ["C123", "/tmp/test-project"],
    ]);
    const sessions: SessionMap = new Map();
    const ccSessions = createCcSessionStore();

    const handler = createMessageHandler({ channelMap, sessions, ccSessions });
    const { args, say } = createMockBoltArgs("C123", "", {
      subtype: "message_deleted",
    });
    await handler(args);

    expect(say).not.toHaveBeenCalled();
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
