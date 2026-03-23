/**
 * Core message handler for the Slack bot.
 *
 * Receives messages via Bolt's app.message() listener, manages reaction indicators,
 * invokes Claude Code via the AI SDK streamText, and posts threaded replies.
 * Supports session continuity (thread replies resume CC sessions) and
 * runtime channel-to-project mapping via /project set slash commands.
 */
import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from "@slack/bolt";
import { streamText } from "ai";
import { claudeCode } from "ai-sdk-provider-claude-code";

import { chunkResponse } from "../chunking.js";
import {
  markError,
  markProcessing,
  markSuccess,
  markWarning,
} from "../reactions.js";
import { resolveClaudeModelId } from "../runners/claude-code-runner.js";
import { collectStream } from "../streaming.js";
import type { CcSessionStore } from "./session-store.js";
import { getCcSessionId, setCcSessionId } from "./session-store.js";
import { parseSlashCommand } from "./slash-commands.js";
import type { ChannelProjectMap, SessionMap } from "./types.js";

export interface HandleMessageOptions {
  /** Channel ID → project directory mapping */
  channelMap: ChannelProjectMap;
  /** In-memory session store */
  sessions: SessionMap;
  /** In-memory CC session store (thread ID → CC session ID) */
  ccSessions: CcSessionStore;
  /** Claude Code model identifier (default: "sonnet") */
  model?: string;
}

/** Bolt message handler arguments. */
export type BoltMessageArgs = SlackEventMiddlewareArgs<"message"> &
  AllMiddlewareArgs;

/**
 * Split a response into paragraph-sized chunks at `\n\n` boundaries.
 * Returns the original text as a single-element array if no paragraph breaks exist.
 *
 * @deprecated Use `chunkResponse()` from `../chunking.js` instead, which also
 * enforces the 39,000 character Slack message limit.
 */
export function splitAtParagraphs(text: string): string[] {
  const chunks = text.split(/\n\n+/).filter((chunk) => chunk.trim().length > 0);
  return chunks.length > 0 ? chunks : [text];
}

/**
 * Creates a message handler function for use with `app.message()`.
 */
export function createMessageHandler(options: HandleMessageOptions) {
  const { channelMap, sessions, ccSessions, model = "sonnet" } = options;

  return async (args: BoltMessageArgs): Promise<void> => {
    const { message, say, client } = args;

    // Filter bot's own messages and message updates/deletions
    const subtype = "subtype" in message ? message.subtype : undefined;
    if (
      "bot_id" in message ||
      subtype === "bot_message" ||
      subtype === "message_changed" ||
      subtype === "message_deleted"
    ) {
      return;
    }

    // Extract message text — only present on GenericMessageEvent (no subtype)
    const text = "text" in message ? (message.text ?? "") : "";

    // Derive thread and message identifiers
    const threadTs =
      "thread_ts" in message ? (message.thread_ts ?? message.ts) : message.ts;
    const messageTs = message.ts;
    const channel = message.channel;

    // Check for slash commands before anything else
    const command = parseSlashCommand(text);
    if (command) {
      if (command.type === "project-set") {
        channelMap.set(channel, command.path);
        await say({
          text: `Project directory for this channel set to \`${command.path}\`.`,
          thread_ts: threadTs,
        });
      }
      return;
    }

    // Add eyes reaction to indicate processing
    await markProcessing(client, channel, messageTs);

    try {
      // Resolve channel → project directory
      const projectDir = channelMap.get(channel);
      if (!projectDir) {
        await say({
          text: `No project directory mapped for channel \`${channel}\`. Please configure a channel-to-project mapping.`,
          thread_ts: threadTs,
        });
        await markWarning(client, channel, messageTs);
        return;
      }

      // Track session
      sessions.set(threadTs, {
        channelId: channel,
        projectDir,
        lastActiveAt: new Date(),
      });

      // Build CC provider options with session continuity
      const resolvedModel = resolveClaudeModelId(model);
      const existingSessionId = getCcSessionId(ccSessions, threadTs);
      const ccOptions: {
        cwd: string;
        permissionMode: "bypassPermissions";
        resume?: string;
      } = {
        cwd: projectDir,
        permissionMode: "bypassPermissions",
      };
      if (existingSessionId) {
        ccOptions.resume = existingSessionId;
      }

      // Invoke Claude Code via AI SDK streamText
      const result = streamText({
        model: claudeCode(resolvedModel, ccOptions),
        prompt: text,
      });

      // Collect full response text via streaming utility
      const fullText = await collectStream(result.textStream);

      // Extract and store session ID from provider metadata for continuity
      const response = await result.response;
      const lastMsg = response.messages?.[response.messages.length - 1] as
        | { providerMetadata?: { "claude-code"?: { sessionId?: string } } }
        | undefined;
      const ccSessionId = lastMsg?.providerMetadata?.["claude-code"]?.sessionId;
      if (ccSessionId) {
        setCcSessionId(ccSessions, threadTs, ccSessionId);
      }

      // Split at paragraph boundaries respecting Slack's 39K char limit
      const chunks = chunkResponse(fullText);
      for (const chunk of chunks) {
        await say({ text: chunk, thread_ts: threadTs });
      }

      // Replace eyes with checkmark on success
      await markSuccess(client, channel, messageTs);
    } catch (error) {
      // Replace eyes with error indicator on failure
      await markError(client, channel, messageTs);

      const errorMessage =
        error instanceof Error ? error.message : "An unexpected error occurred";
      await say({ text: `Error: ${errorMessage}`, thread_ts: threadTs });
    }
  };
}
