/**
 * Core message handler for the Slack bot.
 *
 * Receives messages via Bolt's app.message() listener, manages reaction indicators,
 * invokes Claude Code via the AI SDK streamText, and progressively streams replies
 * using Slack's ChatStreamer API.
 * Supports session continuity (thread replies resume CC sessions) and
 * runtime channel-to-project mapping via /project set slash commands.
 */
import type { AllMiddlewareArgs, SlackEventMiddlewareArgs } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import { streamText } from "ai";
import { claudeCode } from "ai-sdk-provider-claude-code";

import {
  markError,
  markProcessing,
  markSuccess,
  markWarning,
} from "../reactions.js";
import { resolveClaudeModelId } from "../runners/claude-code-runner.js";
import { markdownToMrkdwn } from "./format.js";
import type { CcSessionStore } from "./session-store.js";
import { getCcSessionId, setCcSessionId } from "./session-store.js";
import { parseSlashCommand } from "./slash-commands.js";
import { StreamConsumer } from "./stream-consumer.js";
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

/** Truncate a string to a maximum length, adding ellipsis if truncated. */
function truncateDetail(detail: string, maxLength = 500): string {
  if (detail.length <= maxLength) {
    return detail;
  }
  return `${detail.slice(0, maxLength)}…`;
}

/**
 * Set the assistant thread status (best-effort, silent no-op if scope unavailable).
 */
async function setThinkingStatus(
  client: WebClient,
  channel: string,
  threadTs: string,
): Promise<void> {
  try {
    await client.assistant.threads.setStatus({
      channel_id: channel,
      thread_ts: threadTs,
      status: "is thinking...",
    });
  } catch {
    // Silent no-op — scope may not be available
  }
}

/**
 * Creates a message handler function for use with `app.message()`.
 */
export function createMessageHandler(options: HandleMessageOptions) {
  const { channelMap, sessions, ccSessions, model = "sonnet" } = options;

  return async (args: BoltMessageArgs): Promise<void> => {
    const { message, say, client, context } = args;

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

    // Extract user and team IDs for streaming
    const userId = "user" in message ? (message.user as string) : "";
    const teamId = context.teamId;

    // Check for slash commands before anything else
    const command = parseSlashCommand(text);
    if (command) {
      if (command.type === "project-set") {
        channelMap.set(channel, command.path);
        await say({
          text: markdownToMrkdwn(
            `Project directory for this channel set to \`${command.path}\`.`,
          ),
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
          text: markdownToMrkdwn(
            `No project directory mapped for channel \`${channel}\`. Please configure a channel-to-project mapping.`,
          ),
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

      // Build CC provider options with session continuity.
      // settingSources loads MCP servers, plugins, and skills from the user's
      // Claude config.  It is only passed for NEW sessions — resumed sessions
      // inherit them from the persisted session state.  Passing settingSources
      // on resume would force a fresh session initialisation, breaking
      // conversation continuity.
      const resolvedModel = resolveClaudeModelId(model);
      const existingSessionId = getCcSessionId(ccSessions, threadTs);
      const ccOptions: {
        cwd: string;
        permissionMode: "bypassPermissions";
        settingSources?: Array<"user" | "project">;
        resume?: string;
      } = {
        cwd: projectDir,
        permissionMode: "bypassPermissions",
      };
      if (existingSessionId) {
        ccOptions.resume = existingSessionId;
        process.stderr.write(
          `[session-diag] RESUME thread=${threadTs} sessionId=${existingSessionId}\n`,
        );
      } else {
        ccOptions.settingSources = ["user", "project"];
        process.stderr.write(
          `[session-diag] NEW thread=${threadTs} (no existing session)\n`,
        );
      }

      // Set "is thinking..." status (best-effort)
      await setThinkingStatus(
        client as unknown as WebClient,
        channel,
        threadTs,
      );

      // Invoke Claude Code via AI SDK streamText
      const result = streamText({
        model: claudeCode(resolvedModel, ccOptions),
        prompt: text,
      });

      // Progressively stream response via Slack ChatStreamer
      const consumer = new StreamConsumer(
        client as unknown as WebClient,
        channel,
        threadTs,
        userId,
        teamId,
      );
      try {
        let lastChunkTime = Date.now();
        let chunkCount = 0;
        let totalChars = 0;
        for await (const chunk of result.textStream) {
          const now = Date.now();
          const gap = now - lastChunkTime;
          chunkCount++;
          totalChars += chunk.length;
          if (gap > 3000) {
            process.stderr.write(
              `[stream-diag] ${gap}ms gap before chunk #${chunkCount} (${chunk.length} chars, total ${totalChars})\n`,
            );
          }
          const t0 = Date.now();
          await consumer.append(chunk);
          const appendMs = Date.now() - t0;
          if (appendMs > 1000) {
            process.stderr.write(
              `[stream-diag] append took ${appendMs}ms for chunk #${chunkCount} (${chunk.length} chars)\n`,
            );
          }
          lastChunkTime = Date.now();
        }
        process.stderr.write(
          `[stream-diag] stream complete: ${chunkCount} chunks, ${totalChars} chars\n`,
        );
        await consumer.finish();
      } catch (error) {
        await consumer.finish(); // ensure cleanup
        throw error;
      }

      // Extract and store session ID from provider metadata for continuity.
      // providerMetadata lives on the StreamTextResult itself, NOT on
      // individual response messages (which only carry role + content).
      const metadata = (await result.providerMetadata) as
        | { "claude-code"?: { sessionId?: string } }
        | undefined;
      const ccSessionId = metadata?.["claude-code"]?.sessionId;
      if (ccSessionId) {
        setCcSessionId(ccSessions, threadTs, ccSessionId);
        process.stderr.write(
          `[session-diag] STORED thread=${threadTs} sessionId=${ccSessionId}\n`,
        );
      } else {
        process.stderr.write(
          `[session-diag] NO SESSION ID in providerMetadata (keys: ${metadata ? Object.keys(metadata).join(",") : "null"})\n`,
        );
      }

      // Replace eyes with checkmark on success
      await markSuccess(client, channel, messageTs);
    } catch (error) {
      // Replace eyes with error indicator on failure
      await markError(client, channel, messageTs);

      const errorType =
        error instanceof Error ? error.constructor.name : "Error";
      const errorDetail =
        error instanceof Error ? error.message : "An unexpected error occurred";
      await say({
        text: markdownToMrkdwn(
          `Error: ${errorType}\n${truncateDetail(errorDetail)}`,
        ),
        thread_ts: threadTs,
      });
    }
  };
}
