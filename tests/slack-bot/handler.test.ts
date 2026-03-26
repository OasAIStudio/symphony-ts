import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the AI SDK modules before importing handler
vi.mock("ai", () => ({
  streamText: vi.fn(),
}));

vi.mock("ai-sdk-provider-claude-code", () => ({
  claudeCode: vi.fn(),
}));

vi.mock("../../src/slack-bot/stream-consumer.js", () => ({
  StreamConsumer: vi.fn().mockImplementation(() => ({
    append: vi.fn().mockResolvedValue(undefined),
    finish: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { streamText } from "ai";
import { claudeCode } from "ai-sdk-provider-claude-code";

import {
  type BoltMessageArgs,
  createMessageHandler,
  splitAtParagraphs,
} from "../../src/slack-bot/handler.js";
import { createCcSessionStore } from "../../src/slack-bot/session-store.js";
import { StreamConsumer } from "../../src/slack-bot/stream-consumer.js";
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
    user: string;
    teamId: string;
  }>,
): {
  args: BoltMessageArgs;
  say: ReturnType<typeof vi.fn>;
  client: {
    reactions: {
      add: ReturnType<typeof vi.fn>;
      remove: ReturnType<typeof vi.fn>;
    };
    assistant: {
      threads: {
        setStatus: ReturnType<typeof vi.fn>;
      };
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

  const message: Record<string, unknown> = {
    type: "message" as const,
    text,
    ts: overrides?.ts ?? "1234.5678",
    channel: channelId,
    user: overrides?.user ?? "U_TEST_USER",
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
    context: { teamId: overrides?.teamId ?? "T_TEST_TEAM" },
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
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

// Helper to create a mock streamText return value with response promise.
// providerMetadata lives on the StreamTextResult itself (not on messages).
function createMockStreamResult(chunks: string[], sessionId?: string) {
  return {
    textStream: createAsyncIterable(chunks),
    response: Promise.resolve({ messages: [] }),
    providerMetadata: Promise.resolve(
      sessionId ? { "claude-code": { sessionId } } : undefined,
    ),
  } as unknown as ReturnType<typeof streamText>;
}

describe("createMessageHandler", () => {
  beforeEach(() => {
    // Re-establish StreamConsumer mock implementation (restoreAllMocks clears it)
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

    // Verify claudeCode was called with correct cwd, permissionMode, and settingSources
    expect(claudeCode).toHaveBeenCalledWith("sonnet", {
      cwd: "/tmp/test-project",
      permissionMode: "bypassPermissions",
      settingSources: ["user", "project"],
    });

    // Verify streamText was called with the claudeCode model and prompt
    expect(streamText).toHaveBeenCalledWith({
      model: mockModel,
      prompt: "What files are in this project?",
    });
  });

  it("uses StreamConsumer for progressive streaming", async () => {
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
      createMockStreamResult(["Hello", " world"]),
    );

    const handler = createMessageHandler({
      channelMap,
      sessions,
      ccSessions,
    });

    const { args } = createMockBoltArgs("C123", "What files?");
    await handler(args);

    // Verify StreamConsumer was constructed with correct params
    expect(StreamConsumer).toHaveBeenCalledWith(
      expect.anything(), // client
      "C123", // channel
      "1234.5678", // threadTs
      "U_TEST_USER", // userId
      "T_TEST_TEAM", // teamId
    );

    // Get the mock instance from the constructor's return value
    const consumerInstance = vi.mocked(StreamConsumer).mock.results[0]!
      .value as {
      append: ReturnType<typeof vi.fn>;
      finish: ReturnType<typeof vi.fn>;
    };

    // Verify append was called for each chunk
    expect(consumerInstance.append).toHaveBeenCalledWith("Hello");
    expect(consumerInstance.append).toHaveBeenCalledWith(" world");

    // Verify finish was called
    expect(consumerInstance.finish).toHaveBeenCalled();
  });

  it("sets thinking status before streaming", async () => {
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

    const handler = createMessageHandler({
      channelMap,
      sessions,
      ccSessions,
    });

    const { args, client } = createMockBoltArgs("C123", "test");
    await handler(args);

    expect(client.assistant.threads.setStatus).toHaveBeenCalledWith({
      channel_id: "C123",
      thread_ts: "1234.5678",
      status: "is thinking...",
    });
  });

  it("silently handles setStatus failure", async () => {
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

    const handler = createMessageHandler({
      channelMap,
      sessions,
      ccSessions,
    });

    const { args, client } = createMockBoltArgs("C123", "test");
    client.assistant.threads.setStatus.mockRejectedValue(
      new Error("missing_scope"),
    );

    // Should not throw
    await handler(args);
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

    const handler = createMessageHandler({
      channelMap,
      sessions,
      ccSessions,
    });
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

    const handler = createMessageHandler({
      channelMap,
      sessions,
      ccSessions,
    });
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

  it("handles streamText errors by posting structured error message", async () => {
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

    const handler = createMessageHandler({
      channelMap,
      sessions,
      ccSessions,
    });
    const { args, say, client } = createMockBoltArgs("C123", "test");
    await handler(args);

    // Should post structured error message
    expect(say).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Error:"),
      }),
    );
    expect(say).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("Claude Code failed"),
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

  it("cleans up StreamConsumer on error", async () => {
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
            throw new Error("stream error");
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
      ccSessions,
    });
    const { args } = createMockBoltArgs("C123", "test");
    await handler(args);

    // Get the mock instance from the constructor's return value
    const consumerInstance = vi.mocked(StreamConsumer).mock.results[0]!
      .value as { finish: ReturnType<typeof vi.fn> };

    // finish should have been called for cleanup
    expect(consumerInstance.finish).toHaveBeenCalled();
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

    const handler = createMessageHandler({
      channelMap,
      sessions,
      ccSessions,
    });
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

    const handler = createMessageHandler({
      channelMap,
      sessions,
      ccSessions,
    });
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

    const handler = createMessageHandler({
      channelMap,
      sessions,
      ccSessions,
    });
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

    const handler = createMessageHandler({
      channelMap,
      sessions,
      ccSessions,
    });
    const { args, say } = createMockBoltArgs("C123", "", {
      subtype: "message_deleted",
    });
    await handler(args);

    expect(say).not.toHaveBeenCalled();
  });

  it("resumes CC session for thread replies", async () => {
    const channelMap: ChannelProjectMap = new Map([
      ["C123", "/tmp/test-project"],
    ]);
    const sessions: SessionMap = new Map();
    const ccSessions = createCcSessionStore();
    const mockModel = { id: "mock-claude-code-model" };

    vi.mocked(claudeCode).mockReturnValue(
      mockModel as unknown as ReturnType<typeof claudeCode>,
    );

    // First message: returns a sessionId via providerMetadata
    vi.mocked(streamText).mockReturnValue(
      createMockStreamResult(["First response"], "cc-session-abc"),
    );

    const handler = createMessageHandler({
      channelMap,
      sessions,
      ccSessions,
      model: "sonnet",
    });

    // First message in thread
    const { args: firstArgs } = createMockBoltArgs("C123", "first message", {
      ts: "1000.0001",
    });
    await handler(firstArgs);

    // Verify first call does NOT include resume
    expect(claudeCode).toHaveBeenCalledWith("sonnet", {
      cwd: "/tmp/test-project",
      permissionMode: "bypassPermissions",
      settingSources: ["user", "project"],
    });

    // Second message: reply in same thread
    vi.mocked(claudeCode).mockClear();
    vi.mocked(streamText).mockReturnValue(
      createMockStreamResult(["Second response"], "cc-session-abc"),
    );

    const { args: secondArgs } = createMockBoltArgs("C123", "follow up", {
      ts: "1000.0002",
      thread_ts: "1000.0001",
    });
    await handler(secondArgs);

    // Verify second call includes resume but NOT settingSources
    // (settingSources on resume forces fresh initialisation, breaking context)
    expect(claudeCode).toHaveBeenCalledWith("sonnet", {
      cwd: "/tmp/test-project",
      permissionMode: "bypassPermissions",
      resume: "cc-session-abc",
    });
  });

  it("starts fresh session for new thread (no resume)", async () => {
    const channelMap: ChannelProjectMap = new Map([
      ["C123", "/tmp/test-project"],
    ]);
    const sessions: SessionMap = new Map();
    const ccSessions = createCcSessionStore();
    const mockModel = { id: "mock-claude-code-model" };

    vi.mocked(claudeCode).mockReturnValue(
      mockModel as unknown as ReturnType<typeof claudeCode>,
    );
    vi.mocked(streamText).mockReturnValue(createMockStreamResult(["Hello"]));

    const handler = createMessageHandler({
      channelMap,
      sessions,
      ccSessions,
      model: "sonnet",
    });

    const { args } = createMockBoltArgs("C123", "brand new thread", {
      ts: "9999.0001",
    });
    await handler(args);

    // Should not include resume option
    expect(claudeCode).toHaveBeenCalledWith("sonnet", {
      cwd: "/tmp/test-project",
      permissionMode: "bypassPermissions",
      settingSources: ["user", "project"],
    });
  });

  it("/project set updates channel map and responds", async () => {
    const channelMap: ChannelProjectMap = new Map();
    const sessions: SessionMap = new Map();
    const ccSessions = createCcSessionStore();

    const handler = createMessageHandler({
      channelMap,
      sessions,
      ccSessions,
    });

    const { args, say } = createMockBoltArgs(
      "C123",
      "/project set /home/user/new-project",
    );
    await handler(args);

    // Channel map should be updated
    expect(channelMap.get("C123")).toBe("/home/user/new-project");

    // Should respond with confirmation
    expect(say).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("/home/user/new-project"),
      }),
    );

    // Should NOT call streamText (slash command short-circuits)
    expect(streamText).not.toHaveBeenCalled();
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
