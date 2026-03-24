import { describe, expect, it, vi } from "vitest";

import {
  markError,
  markProcessing,
  markSuccess,
  markWarning,
} from "../../src/reactions.js";

/** Create a mock WebClient with reactions.add and reactions.remove. */
function createMockClient() {
  return {
    reactions: {
      add: vi.fn().mockResolvedValue({ ok: true }),
      remove: vi.fn().mockResolvedValue({ ok: true }),
    },
  };
}

describe("markProcessing", () => {
  it('adds "eyes" reaction', async () => {
    const client = createMockClient();

    await markProcessing(client as never, "C123", "1234.5678");

    expect(client.reactions.add).toHaveBeenCalledWith({
      channel: "C123",
      timestamp: "1234.5678",
      name: "eyes",
    });
    expect(client.reactions.add).toHaveBeenCalledTimes(1);
    expect(client.reactions.remove).not.toHaveBeenCalled();
  });
});

describe("markSuccess", () => {
  it('removes "eyes" and adds "white_check_mark"', async () => {
    const client = createMockClient();

    await markSuccess(client as never, "C123", "1234.5678");

    expect(client.reactions.remove).toHaveBeenCalledWith({
      channel: "C123",
      timestamp: "1234.5678",
      name: "eyes",
    });
    expect(client.reactions.add).toHaveBeenCalledWith({
      channel: "C123",
      timestamp: "1234.5678",
      name: "white_check_mark",
    });
  });
});

describe("markError", () => {
  it('removes "eyes" and adds "x"', async () => {
    const client = createMockClient();

    await markError(client as never, "C123", "1234.5678");

    expect(client.reactions.remove).toHaveBeenCalledWith({
      channel: "C123",
      timestamp: "1234.5678",
      name: "eyes",
    });
    expect(client.reactions.add).toHaveBeenCalledWith({
      channel: "C123",
      timestamp: "1234.5678",
      name: "x",
    });
  });
});

describe("markWarning", () => {
  it('removes "eyes" and adds "warning"', async () => {
    const client = createMockClient();

    await markWarning(client as never, "C123", "1234.5678");

    expect(client.reactions.remove).toHaveBeenCalledWith({
      channel: "C123",
      timestamp: "1234.5678",
      name: "eyes",
    });
    expect(client.reactions.add).toHaveBeenCalledWith({
      channel: "C123",
      timestamp: "1234.5678",
      name: "warning",
    });
  });
});
