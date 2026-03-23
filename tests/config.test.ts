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
import { createCcSessionStore } from "../src/slack-bot/session-store.js";
import { parseSlashCommand } from "../src/slack-bot/slash-commands.js";
import type { ChannelProjectMap, SessionMap } from "../src/slack-bot/types.js";

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

describe("parseSlashCommand", () => {
  it("parses /project set with a path", () => {
    const result = parseSlashCommand("/project set ~/projects/jony");
    expect(result).toEqual({
      type: "project-set",
      path: "~/projects/jony",
    });
  });

  it("parses /project set with absolute path", () => {
    const result = parseSlashCommand("/project set /home/user/myapp");
    expect(result).toEqual({
      type: "project-set",
      path: "/home/user/myapp",
    });
  });

  it("trims whitespace from the command", () => {
    const result = parseSlashCommand("  /project set ~/projects/jony  ");
    expect(result).toEqual({
      type: "project-set",
      path: "~/projects/jony",
    });
  });

  it("returns null for non-slash-command messages", () => {
    expect(parseSlashCommand("Hello, how are you?")).toBeNull();
  });

  it("returns null for unknown slash commands", () => {
    expect(parseSlashCommand("/unknown command")).toBeNull();
  });

  it("returns null for /project without set subcommand", () => {
    expect(parseSlashCommand("/project")).toBeNull();
  });

  it("returns null for /project set without a path", () => {
    expect(parseSlashCommand("/project set")).toBeNull();
  });
});

describe("Channel-to-project mapping via slash command", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("updates channelMap when /project set is used", async () => {
    const channelMap: ChannelProjectMap = new Map();
    const sessions: SessionMap = new Map();
    const ccSessions = createCcSessionStore();

    const handler = createMessageHandler({
      channelMap,
      sessions,
      ccSessions,
    });

    const thread = createMockThread("C456");
    const message = createMockMessage("/project set ~/projects/jony");

    await handler(
      thread as unknown as Parameters<typeof handler>[0],
      message as unknown as Parameters<typeof handler>[1],
    );

    // Verify channelMap was updated
    expect(channelMap.get("C456")).toBe("~/projects/jony");

    // Verify confirmation message was posted
    expect(thread.post).toHaveBeenCalledWith(
      expect.stringContaining("~/projects/jony"),
    );

    // Verify Claude Code was NOT invoked for the slash command
    expect(streamText).not.toHaveBeenCalled();
    expect(claudeCode).not.toHaveBeenCalled();

    // Verify no reaction was added (slash commands skip reaction flow)
    expect(thread.adapter.addReaction).not.toHaveBeenCalled();
  });

  it("uses updated project dir for subsequent messages in the channel", async () => {
    const channelMap: ChannelProjectMap = new Map();
    const sessions: SessionMap = new Map();
    const ccSessions = createCcSessionStore();
    const mockModel = { id: "mock-claude-code-model" };

    vi.mocked(claudeCode).mockReturnValue(
      mockModel as unknown as ReturnType<typeof claudeCode>,
    );
    vi.mocked(streamText).mockReturnValue(createMockStreamResult(["Done"]));

    const handler = createMessageHandler({
      channelMap,
      sessions,
      ccSessions,
    });

    // First: set the project via slash command
    const thread1 = createMockThread("C456");
    const setMessage = createMockMessage("/project set ~/projects/jony");

    await handler(
      thread1 as unknown as Parameters<typeof handler>[0],
      setMessage as unknown as Parameters<typeof handler>[1],
    );

    // Then: send a regular message in the same channel
    const thread2 = createMockThread("C456");
    const regularMessage = createMockMessage("What files are here?");

    await handler(
      thread2 as unknown as Parameters<typeof handler>[0],
      regularMessage as unknown as Parameters<typeof handler>[1],
    );

    // Verify claudeCode was called with the new project dir
    expect(claudeCode).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ cwd: "~/projects/jony" }),
    );
  });

  it("overwrites existing channel mapping with /project set", async () => {
    const channelMap: ChannelProjectMap = new Map([["C456", "/old/project"]]);
    const sessions: SessionMap = new Map();
    const ccSessions = createCcSessionStore();

    const handler = createMessageHandler({
      channelMap,
      sessions,
      ccSessions,
    });

    const thread = createMockThread("C456");
    const message = createMockMessage("/project set /new/project");

    await handler(
      thread as unknown as Parameters<typeof handler>[0],
      message as unknown as Parameters<typeof handler>[1],
    );

    expect(channelMap.get("C456")).toBe("/new/project");
  });
});
