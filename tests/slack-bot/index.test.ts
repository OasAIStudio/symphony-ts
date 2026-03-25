import { describe, expect, it, vi } from "vitest";

// Mock @slack/bolt before importing
vi.mock("@slack/bolt", () => ({
  App: vi.fn().mockImplementation(() => ({
    message: vi.fn(),
    start: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { App } from "@slack/bolt";
import { createSlackBoltApp } from "../../src/slack-bot/index.js";
import { loadSlackBotConfig } from "../../src/slack-bot/server.js";

describe("createSlackBoltApp", () => {
  it("constructs App with socketMode: true", () => {
    const channelMap = new Map([["C123", "/tmp/project"]]);

    createSlackBoltApp({
      botToken: "xoxb-test",
      appToken: "xapp-test",
      channelMap,
    });

    expect(App).toHaveBeenCalledWith({
      token: "xoxb-test",
      appToken: "xapp-test",
      socketMode: true,
    });
  });
});

describe("env var validation", () => {
  it("throws clear error when SLACK_APP_TOKEN is missing", () => {
    expect(() => loadSlackBotConfig({ SLACK_BOT_TOKEN: "xoxb-test" })).toThrow(
      "SLACK_APP_TOKEN",
    );
  });

  it("throws clear error when SLACK_BOT_TOKEN is missing", () => {
    expect(() => loadSlackBotConfig({ SLACK_APP_TOKEN: "xapp-test" })).toThrow(
      "SLACK_BOT_TOKEN",
    );
  });
});
