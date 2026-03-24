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

import type { BoltMessageArgs } from "../src/slack-bot/handler.js";
import { createMessageHandler } from "../src/slack-bot/handler.js";
import { createCcSessionStore } from "../src/slack-bot/session-store.js";
import { parseSlashCommand } from "../src/slack-bot/slash-commands.js";
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

    const { args, say, client } = createMockBoltArgs(
      "C456",
      "/project set ~/projects/jony",
    );
    await handler(args);

    // Verify channelMap was updated
    expect(channelMap.get("C456")).toBe("~/projects/jony");

    // Verify confirmation message was posted
    expect(say).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining("~/projects/jony"),
      }),
    );

    // Verify Claude Code was NOT invoked for the slash command
    expect(streamText).not.toHaveBeenCalled();
    expect(claudeCode).not.toHaveBeenCalled();

    // Verify no reaction was added (slash commands skip reaction flow)
    expect(client.reactions.add).not.toHaveBeenCalled();
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
    const setArgs = createMockBoltArgs("C456", "/project set ~/projects/jony");
    await handler(setArgs.args);

    // Then: send a regular message in the same channel
    const regularArgs = createMockBoltArgs("C456", "What files are here?");
    await handler(regularArgs.args);

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

    const { args } = createMockBoltArgs("C456", "/project set /new/project");
    await handler(args);

    expect(channelMap.get("C456")).toBe("/new/project");
  });
});
