/**
 * Thin wrapper around Slack's `client.chatStream()` for progressive streaming.
 *
 * Adds lazy initialization (stream created on first `append()` call),
 * overflow handling (starts a new stream at 39K boundary), and error cleanup.
 *
 * The `ChatStreamer` class in `@slack/web-api` already handles buffering
 * (default 256 bytes) and the start/append/stop lifecycle. This wrapper
 * only adds lazy init, overflow, and error cleanup.
 */
import type { WebClient } from "@slack/web-api";
import type { ChatStreamer } from "@slack/web-api/dist/chat-stream.js";

import { SLACK_MAX_CHARS } from "../chunking.js";

/**
 * Maximum characters before starting a new stream.
 * Uses the same 39K boundary as chunk-based posting.
 */
const STREAM_OVERFLOW_CHARS = SLACK_MAX_CHARS;

export class StreamConsumer {
  private client: WebClient;
  private channel: string;
  private threadTs: string;
  private recipientUserId: string;
  private recipientTeamId: string | undefined;

  private streamer: ChatStreamer | null = null;
  private charCount = 0;

  constructor(
    client: WebClient,
    channel: string,
    threadTs: string,
    recipientUserId: string,
    recipientTeamId: string | undefined,
  ) {
    this.client = client;
    this.channel = channel;
    this.threadTs = threadTs;
    this.recipientUserId = recipientUserId;
    this.recipientTeamId = recipientTeamId;
  }

  /**
   * Append text to the current stream. Creates the stream lazily on first call.
   * If accumulated text exceeds the overflow boundary, stops the current stream
   * and starts a fresh one.
   */
  async append(text: string): Promise<void> {
    // Check if appending would overflow the current stream
    if (
      this.streamer !== null &&
      this.charCount + text.length > STREAM_OVERFLOW_CHARS
    ) {
      await this.stopCurrentStream();
    }

    // Lazy init: create stream on first append (or after overflow reset)
    if (this.streamer === null) {
      this.streamer = this.createStreamer();
      this.charCount = 0;
    }

    await this.streamer.append({ markdown_text: text });
    this.charCount += text.length;
  }

  /**
   * Finalize the stream. Must be called when done (typically in a finally block).
   * Safe to call even if no stream was started (no-op).
   */
  async finish(): Promise<void> {
    await this.stopCurrentStream();
  }

  private createStreamer(): ChatStreamer {
    const args: {
      channel: string;
      thread_ts: string;
      recipient_user_id?: string;
      recipient_team_id?: string;
    } = {
      channel: this.channel,
      thread_ts: this.threadTs,
      recipient_user_id: this.recipientUserId,
    };

    if (this.recipientTeamId !== undefined) {
      args.recipient_team_id = this.recipientTeamId;
    }

    return this.client.chatStream(args);
  }

  private async stopCurrentStream(): Promise<void> {
    if (this.streamer !== null) {
      try {
        await this.streamer.stop();
      } catch {
        // Best-effort cleanup — stream may already be stopped or failed
      }
      this.streamer = null;
      this.charCount = 0;
    }
  }
}
