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

import { createMessageHandler } from "../src/slack-bot/handler.js";
import {
  createCcSessionStore,
  getCcSessionId,
  setCcSessionId,
} from "../src/slack-bot/session-store.js";
import type { ChannelProjectMap, SessionMap } from "../src/slack-bot/types.js";

// Helper to create a mock thread
function createMockThread(channelId: string, threadTs: string) {
  return {
    id: `slack:${channelId}:${threadTs}`,
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
    const threadId = "slack:C123:1234.5678";

    // Pre-populate a CC session ID for this thread (simulates prior interaction)
    setCcSessionId(ccSessions, threadId, "existing-session-id");

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

    const thread = createMockThread("C123", "1234.5678");
    const message = createMockMessage("follow-up question");

    await handler(
      thread as unknown as Parameters<typeof handler>[0],
      message as unknown as Parameters<typeof handler>[1],
    );

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

    const thread = createMockThread("C123", "5678.9012");
    const message = createMockMessage("brand new message");

    await handler(
      thread as unknown as Parameters<typeof handler>[0],
      message as unknown as Parameters<typeof handler>[1],
    );

    // Verify claudeCode was called WITHOUT resume
    expect(claudeCode).toHaveBeenCalledWith(expect.any(String), {
      cwd: "/tmp/test-project",
      permissionMode: "bypassPermissions",
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

    const thread = createMockThread("C123", "1234.5678");
    const message = createMockMessage("test");

    await handler(
      thread as unknown as Parameters<typeof handler>[0],
      message as unknown as Parameters<typeof handler>[1],
    );

    // Verify session ID was stored
    expect(getCcSessionId(ccSessions, thread.id)).toBe("returned-session-id");
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

    const thread = createMockThread("C123", "1234.5678");
    const message = createMockMessage("test");

    await handler(
      thread as unknown as Parameters<typeof handler>[0],
      message as unknown as Parameters<typeof handler>[1],
    );

    // Verify no session ID was stored
    expect(getCcSessionId(ccSessions, thread.id)).toBeUndefined();
  });
});
