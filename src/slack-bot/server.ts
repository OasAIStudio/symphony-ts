/**
 * Standalone entry point for the Slack bot using Socket Mode.
 *
 * Reads configuration from environment variables, creates a Bolt app,
 * registers handlers, and starts Socket Mode connection.
 */
import { parseChannelProjectMap, startSlackBot } from "./index.js";
import type { SlackBotConfig } from "./types.js";

/**
 * Load and validate Slack bot configuration from environment variables.
 *
 * Required env vars: SLACK_BOT_TOKEN, SLACK_APP_TOKEN
 * Optional: CHANNEL_PROJECT_MAP (JSON, default {}), CLAUDE_MODEL
 *
 * @throws {Error} If required environment variables are missing.
 */
export function loadSlackBotConfig(
  env: Record<string, string | undefined> = process.env,
): SlackBotConfig {
  const missing: string[] = [];

  const botToken = env.SLACK_BOT_TOKEN;
  if (!botToken) {
    missing.push("SLACK_BOT_TOKEN");
  }

  const appToken = env.SLACK_APP_TOKEN;
  if (!appToken) {
    missing.push("SLACK_APP_TOKEN");
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required environment variables: ${missing.join(", ")}`,
    );
  }

  // At this point both botToken and appToken are defined (missing.length === 0).
  const resolvedBotToken = botToken as string;
  const resolvedAppToken = appToken as string;

  const channelMapJson = env.CHANNEL_PROJECT_MAP ?? "{}";
  const channelMap = parseChannelProjectMap(channelMapJson);

  const model = env.CLAUDE_MODEL;

  return {
    botToken: resolvedBotToken,
    appToken: resolvedAppToken,
    channelMap,
    ...(model !== undefined ? { model } : {}),
  };
}

/* Entry point for direct execution: node dist/src/slack-bot/server.js */
const isDirectExecution =
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("/src/slack-bot/server.js");

if (isDirectExecution) {
  try {
    const config = loadSlackBotConfig();
    void startSlackBot(config);
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Failed to start Slack bot",
    );
    process.exit(1);
  }
}
