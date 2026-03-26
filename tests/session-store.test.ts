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
import {
  createCcSessionStore,
  getCcSessionId,
  setCcSessionId,
} from "../src/slack-bot/session-store.js";
import { StreamConsumer } from "../src/slack-bot/stream-consumer.js";
import type { ChannelProjectMap, SessionMap } from "../src/slack-bot/types.js";

/** Create a mock Bolt message args object. */
function createMockBoltArgs(
  channelId: string,
  text: string,
  overrides?: Partial<{
    ts: string;
    thread_ts: string;
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
    user: "U_TEST_USER",
  };
  if (overrides?.thread_ts) {
    message.thread_ts = overrides.thread_ts;
  }

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

describe("CcSessionStore", () => {
  it("returns undefined for unknown thread ID", () => {
    const store = createCcSessionStore();
    expect(getCcSessionId(store, "slack:C123:1234.5678")).toBeUndefined();
  });

  it("stores and retrieves a session ID for a thread", () => {
    const store = createCcSessionStore();
    setCcSessionId(store, "slack:C123:1234.5678", "session-abc-123");
    expect(getCcSessionId(store, "slack:C123:1234.5678")).toBe(
      "session-abc-123",
    );
  });

  it("overwrites existing session ID for the same thread", () => {
    const store = createCcSessionStore();
    setCcSessionId(store, "slack:C123:1234.5678", "session-old");
    setCcSessionId(store, "slack:C123:1234.5678", "session-new");
    expect(getCcSessionId(store, "slack:C123:1234.5678")).toBe("session-new");
  });

  it("stores different session IDs for different threads", () => {
    const store = createCcSessionStore();
    setCcSessionId(store, "slack:C123:1111.0000", "session-a");
    setCcSessionId(store, "slack:C123:2222.0000", "session-b");
    expect(getCcSessionId(store, "slack:C123:1111.0000")).toBe("session-a");
    expect(getCcSessionId(store, "slack:C123:2222.0000")).toBe("session-b");
  });
});

describe("Session continuity in handler", () => {
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

  it("passes resume to claudeCode for thread replies with existing session", async () => {
    const channelMap: ChannelProjectMap = new Map([
      ["C123", "/tmp/test-project"],
    ]);
    const sessions: SessionMap = new Map();
    const ccSessions = createCcSessionStore();
    const mockModel = { id: "mock-claude-code-model" };
    // Thread ID = message.thread_ts || message.ts
    const threadTs = "1234.5678";

    // Pre-populate a CC session ID for this thread (simulates prior interaction)
    setCcSessionId(ccSessions, threadTs, "existing-session-id");

    vi.mocked(claudeCode).mockReturnValue(
      mockModel as unknown as ReturnType<typeof claudeCode>,
    );
    vi.mocked(streamText).mockReturnValue(
      createMockStreamResult(["Follow-up response"], "updated-session-id"),
    );

    const handler = createMessageHandler({
      channelMap,
      sessions,
      ccSessions,
    });

    const { args } = createMockBoltArgs("C123", "follow-up question", {
      ts: "1234.9999",
      thread_ts: threadTs,
    });
    await handler(args);

    // Verify claudeCode was called with resume option
    expect(claudeCode).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        cwd: "/tmp/test-project",
        permissionMode: "bypassPermissions",
        resume: "existing-session-id",
      }),
    );
  });

  it("does not pass resume for new top-level messages (no existing session)", async () => {
    const channelMap: ChannelProjectMap = new Map([
      ["C123", "/tmp/test-project"],
    ]);
    const sessions: SessionMap = new Map();
    const ccSessions = createCcSessionStore();
    const mockModel = { id: "mock-claude-code-model" };

    // ccSessions is empty — no prior session exists

    vi.mocked(claudeCode).mockReturnValue(
      mockModel as unknown as ReturnType<typeof claudeCode>,
    );
    vi.mocked(streamText).mockReturnValue(
      createMockStreamResult(["Fresh response"], "new-session-id"),
    );

    const handler = createMessageHandler({
      channelMap,
      sessions,
      ccSessions,
    });

    const { args } = createMockBoltArgs("C123", "brand new message", {
      ts: "5678.9012",
    });
    await handler(args);

    // Verify claudeCode was called WITHOUT resume
    expect(claudeCode).toHaveBeenCalledWith(expect.any(String), {
      cwd: "/tmp/test-project",
      permissionMode: "bypassPermissions",
      settingSources: ["user", "project"],
    });
  });

  it("stores session ID from provider metadata after response", async () => {
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
      createMockStreamResult(["Hello"], "returned-session-id"),
    );

    const handler = createMessageHandler({
      channelMap,
      sessions,
      ccSessions,
    });

    const { args } = createMockBoltArgs("C123", "test", { ts: "1234.5678" });
    await handler(args);

    // Thread ID = message.thread_ts || message.ts = "1234.5678"
    expect(getCcSessionId(ccSessions, "1234.5678")).toBe("returned-session-id");
  });

  it("does not store session ID when provider metadata lacks it", async () => {
    const channelMap: ChannelProjectMap = new Map([
      ["C123", "/tmp/test-project"],
    ]);
    const sessions: SessionMap = new Map();
    const ccSessions = createCcSessionStore();
    const mockModel = { id: "mock-claude-code-model" };

    vi.mocked(claudeCode).mockReturnValue(
      mockModel as unknown as ReturnType<typeof claudeCode>,
    );
    // No sessionId in the response
    vi.mocked(streamText).mockReturnValue(createMockStreamResult(["Hello"]));

    const handler = createMessageHandler({
      channelMap,
      sessions,
      ccSessions,
    });

    const { args } = createMockBoltArgs("C123", "test", { ts: "1234.5678" });
    await handler(args);

    // Verify no session ID was stored
    expect(getCcSessionId(ccSessions, "1234.5678")).toBeUndefined();
  });
});
