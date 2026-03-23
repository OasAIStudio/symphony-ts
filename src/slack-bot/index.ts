/**
 * Slack bot entry point.
 *
 * Configures a Chat instance with SlackAdapter and MemoryStateAdapter,
 * registers message handlers, and exports the webhook handler.
 */
import { createSlackAdapter } from "@chat-adapter/slack";
import { createMemoryState } from "@chat-adapter/state-memory";
import { type Adapter, Chat } from "chat";

import { createMessageHandler } from "./handler.js";
import { createCcSessionStore } from "./session-store.js";
import type { ChannelProjectMap, SessionMap, SlackBotConfig } from "./types.js";

export type { SlackBotConfig, ChannelProjectMap, SessionMap } from "./types.js";
export type { CcSessionStore } from "./session-store.js";
export {
  createCcSessionStore,
  getCcSessionId,
  setCcSessionId,
} from "./session-store.js";
export { parseSlashCommand } from "./slash-commands.js";
export { createMessageHandler, splitAtParagraphs } from "./handler.js";

/**
 * Parse a JSON string of channel→project mappings into a ChannelProjectMap.
 * Expected format: `{ "C123": "/path/to/project", "C456": "/other/project" }`
 */
export function parseChannelProjectMap(json: string): ChannelProjectMap {
  const parsed: unknown = JSON.parse(json);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("CHANNEL_PROJECT_MAP must be a JSON object");
  }
  const map: ChannelProjectMap = new Map();
  for (const [key, value] of Object.entries(
    parsed as Record<string, unknown>,
  )) {
    if (typeof value !== "string") {
      throw new Error(
        `CHANNEL_PROJECT_MAP values must be strings, got ${typeof value} for key "${key}"`,
      );
    }
    map.set(key, value);
  }
  return map;
}

/** In-memory session store shared across handlers. */
const sessions: SessionMap = new Map();

/** In-memory CC session store for session continuity. */
const ccSessions = createCcSessionStore();

/**
 * Create and configure a Chat instance for the Slack bot.
 *
 * Returns the Chat instance and its type-safe webhook handler.
 */
export function createSlackBot(config: SlackBotConfig) {
  const { botToken, signingSecret, channelMap, model } = config;

  const chat = new Chat({
    userName: "symphony-bot",
    adapters: {
      slack: createSlackAdapter({ botToken, signingSecret }) as Adapter,
    },
    state: createMemoryState(),
  });

  const handler = createMessageHandler({
    channelMap,
    sessions,
    ccSessions,
    ...(model !== undefined ? { model } : {}),
  });

  // Match ALL messages — no @mention required per spec
  chat.onNewMessage(/.*/, handler);

  return {
    chat,
    /** Webhook handler for Slack events — pass incoming HTTP requests here. */
    webhooks: chat.webhooks,
    /** The in-memory session store (exposed for testing / monitoring). */
    sessions,
    /** The in-memory CC session store (exposed for testing / monitoring). */
    ccSessions,
  };
}
