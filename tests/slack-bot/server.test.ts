import { describe, expect, it } from "vitest";

import { loadSlackBotConfig } from "../../src/slack-bot/server.js";

describe("loadSlackBotConfig", () => {
  it("exits with error when required env vars are missing", () => {
    expect(() => loadSlackBotConfig({})).toThrow();
  });

  it("names the missing variable SLACK_BOT_TOKEN", () => {
    expect(() => loadSlackBotConfig({ SLACK_APP_TOKEN: "xapp-token" })).toThrow(
      "SLACK_BOT_TOKEN",
    );
  });

  it("names the missing variable SLACK_APP_TOKEN", () => {
    expect(() => loadSlackBotConfig({ SLACK_BOT_TOKEN: "xoxb-token" })).toThrow(
      "SLACK_APP_TOKEN",
    );
  });

  it("parses channel project map from JSON", () => {
    const config = loadSlackBotConfig({
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_APP_TOKEN: "xapp-test",
      CHANNEL_PROJECT_MAP: '{"C123":"/tmp/project-a"}',
    });
    expect(config.channelMap).toBeInstanceOf(Map);
    expect(config.channelMap.get("C123")).toBe("/tmp/project-a");
  });

  it("empty channel map when CHANNEL_PROJECT_MAP is not set", () => {
    const config = loadSlackBotConfig({
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_APP_TOKEN: "xapp-test",
    });
    expect(config.channelMap).toBeInstanceOf(Map);
    expect(config.channelMap.size).toBe(0);
  });

  it("includes CLAUDE_MODEL when set", () => {
    const config = loadSlackBotConfig({
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_APP_TOKEN: "xapp-test",
      CLAUDE_MODEL: "opus",
    });
    expect(config.model).toBe("opus");
  });

  it("omits model when CLAUDE_MODEL is not set", () => {
    const config = loadSlackBotConfig({
      SLACK_BOT_TOKEN: "xoxb-test",
      SLACK_APP_TOKEN: "xapp-test",
    });
    expect(config.model).toBeUndefined();
  });
});
