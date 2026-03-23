/**
 * Type definitions for the Slack bot module.
 *
 * Channel-to-project-directory mappings and session state are stored
 * in-memory (Map) for v1 — Redis is a future enhancement.
 */

/** Maps Slack channel IDs to local project directories for Claude Code cwd. */
export type ChannelProjectMap = Map<string, string>;

/** Configuration for the Slack bot. */
export interface SlackBotConfig {
  /** Slack bot token (xoxb-...) */
  botToken: string;
  /** Slack app-level token (xapp-...) for Socket Mode */
  appToken: string;
  /** Channel ID → project directory mapping */
  channelMap: ChannelProjectMap;
  /**
   * Claude Code model identifier (e.g. "sonnet", "opus", "haiku").
   * Defaults to "sonnet".
   */
  model?: string;
}

/** Per-thread session state stored in memory. */
export interface SessionState {
  /** The Slack channel ID where the conversation started */
  channelId: string;
  /** The project directory mapped to the channel */
  projectDir: string;
  /** Timestamp of the last interaction */
  lastActiveAt: Date;
}

/** In-memory session map keyed by thread ID. */
export type SessionMap = Map<string, SessionState>;
