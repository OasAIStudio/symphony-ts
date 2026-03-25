import { describe, expect, it, vi } from "vitest";

import { SLACK_MAX_CHARS } from "../../src/chunking.js";
import { StreamConsumer } from "../../src/slack-bot/stream-consumer.js";

/** Create a mock WebClient with chatStream support. */
function createMockClient() {
  const mockStreamer = {
    append: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };

  const client = {
    chatStream: vi.fn().mockReturnValue(mockStreamer),
  };

  return { client, mockStreamer };
}

describe("StreamConsumer", () => {
  it("creates stream lazily on first append", async () => {
    const { client, mockStreamer } = createMockClient();

    const consumer = new StreamConsumer(
      client as never,
      "C123",
      "1234.5678",
      "U456",
      "T789",
    );

    // No stream created yet
    expect(client.chatStream).not.toHaveBeenCalled();

    await consumer.append("Hello");

    // Now stream should be created
    expect(client.chatStream).toHaveBeenCalledTimes(1);
    expect(client.chatStream).toHaveBeenCalledWith({
      channel: "C123",
      thread_ts: "1234.5678",
      recipient_user_id: "U456",
      recipient_team_id: "T789",
    });

    // Text should be appended
    expect(mockStreamer.append).toHaveBeenCalledWith({
      markdown_text: "Hello",
    });
  });

  it("finish is a no-op when no stream was started", async () => {
    const { client } = createMockClient();

    const consumer = new StreamConsumer(
      client as never,
      "C123",
      "1234.5678",
      "U456",
      "T789",
    );

    // Should not throw
    await consumer.finish();
    expect(client.chatStream).not.toHaveBeenCalled();
  });

  it("finish stops the current stream", async () => {
    const { client, mockStreamer } = createMockClient();

    const consumer = new StreamConsumer(
      client as never,
      "C123",
      "1234.5678",
      "U456",
      "T789",
    );

    await consumer.append("Hello");
    await consumer.finish();

    expect(mockStreamer.stop).toHaveBeenCalledTimes(1);
  });

  it("handles overflow by starting a new stream at 39K boundary", async () => {
    const streamers = [
      {
        append: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
      },
      {
        append: vi.fn().mockResolvedValue(undefined),
        stop: vi.fn().mockResolvedValue(undefined),
      },
    ];
    let streamIndex = 0;

    const client = {
      chatStream: vi.fn().mockImplementation(() => {
        const s = streamers[streamIndex];
        streamIndex++;
        return s;
      }),
    };

    const consumer = new StreamConsumer(
      client as never,
      "C123",
      "1234.5678",
      "U456",
      "T789",
    );

    // Append text that's just under the limit
    const nearLimit = "x".repeat(SLACK_MAX_CHARS - 100);
    await consumer.append(nearLimit);

    expect(client.chatStream).toHaveBeenCalledTimes(1);

    // Append text that pushes over the limit
    const overflow = "y".repeat(200);
    await consumer.append(overflow);

    // Should have created a second stream
    expect(client.chatStream).toHaveBeenCalledTimes(2);

    // First stream should have been stopped
    expect(streamers[0]!.stop).toHaveBeenCalledTimes(1);

    // Second stream should have the overflow text
    expect(streamers[1]!.append).toHaveBeenCalledWith({
      markdown_text: overflow,
    });

    await consumer.finish();
    expect(streamers[1]!.stop).toHaveBeenCalledTimes(1);
  });

  it("handles undefined teamId", async () => {
    const { client } = createMockClient();

    const consumer = new StreamConsumer(
      client as never,
      "C123",
      "1234.5678",
      "U456",
      undefined,
    );

    await consumer.append("Hello");

    expect(client.chatStream).toHaveBeenCalledWith({
      channel: "C123",
      thread_ts: "1234.5678",
      recipient_user_id: "U456",
    });
  });

  it("suppresses errors from stop during cleanup", async () => {
    const mockStreamer = {
      append: vi.fn().mockResolvedValue(undefined),
      stop: vi.fn().mockRejectedValue(new Error("stream already stopped")),
    };

    const client = {
      chatStream: vi.fn().mockReturnValue(mockStreamer),
    };

    const consumer = new StreamConsumer(
      client as never,
      "C123",
      "1234.5678",
      "U456",
      "T789",
    );

    await consumer.append("Hello");

    // Should not throw even though stop() rejects
    await consumer.finish();
  });

  it("appends multiple chunks to the same stream within limit", async () => {
    const { client, mockStreamer } = createMockClient();

    const consumer = new StreamConsumer(
      client as never,
      "C123",
      "1234.5678",
      "U456",
      "T789",
    );

    await consumer.append("Hello ");
    await consumer.append("world");

    // Only one stream created
    expect(client.chatStream).toHaveBeenCalledTimes(1);

    // Two appends
    expect(mockStreamer.append).toHaveBeenCalledTimes(2);
    expect(mockStreamer.append).toHaveBeenNthCalledWith(1, {
      markdown_text: "Hello ",
    });
    expect(mockStreamer.append).toHaveBeenNthCalledWith(2, {
      markdown_text: "world",
    });

    await consumer.finish();
  });
});
