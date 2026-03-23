/**
 * Slack bot entry point.
 *
 * Configures a Bolt App with Socket Mode,
 * registers message handlers, and exports the app.
 */
import { App } from "@slack/bolt";

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
export { markdownToMrkdwn } from "./format.js";
export { StreamConsumer } from "./stream-consumer.js";
export { chunkResponse, SLACK_MAX_CHARS } from "../chunking.js";
export {
  markProcessing,
  markSuccess,
  markError,
  markWarning,
} from "../reactions.js";
export { collectStream } from "../streaming.js";

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
 * Create and configure a Bolt App for the Slack bot using Socket Mode.
 *
 * Returns the App instance and associated session stores.
 */
export function createSlackBoltApp(config: SlackBotConfig) {
  const { botToken, appToken, channelMap, model } = config;

  const app = new App({
    token: botToken,
    appToken,
    socketMode: true,
  });

  const handler = createMessageHandler({
    channelMap,
    sessions,
    ccSessions,
    ...(model !== undefined ? { model } : {}),
  });

  // Match ALL messages — no @mention required per spec
  app.message(handler);

  return {
    app,
    /** The in-memory session store (exposed for testing / monitoring). */
    sessions,
    /** The in-memory CC session store (exposed for testing / monitoring). */
    ccSessions,
  };
}

/**
 * Start the Slack bot using Socket Mode.
 *
 * Creates the Bolt app, registers handlers, and connects via WebSocket.
 */
export async function startSlackBot(config: SlackBotConfig): Promise<{
  app: App;
  sessions: SessionMap;
  ccSessions: ReturnType<typeof createCcSessionStore>;
}> {
  const result = createSlackBoltApp(config);

  await result.app.start();

  const channelCount = config.channelMap.size;
  console.log(
    `Slack bot connected via Socket Mode (${channelCount} channel mapping${channelCount === 1 ? "" : "s"})`,
  );

  return result;
}
