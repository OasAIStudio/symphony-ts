import { describe, expect, it } from "vitest";

import { markdownToMrkdwn } from "../../src/slack-bot/format.js";

describe("markdownToMrkdwn", () => {
  it("converts markdown links to Slack mrkdwn links", () => {
    expect(markdownToMrkdwn("[Click here](https://example.com)")).toBe(
      "<https://example.com|Click here>",
    );
  });

  it("converts headers to bold text", () => {
    expect(markdownToMrkdwn("## My Header")).toBe("*My Header*");
    expect(markdownToMrkdwn("# Title")).toBe("*Title*");
    expect(markdownToMrkdwn("### Subsection")).toBe("*Subsection*");
  });

  it("converts bold markdown to Slack bold", () => {
    expect(markdownToMrkdwn("This is **bold** text")).toBe(
      "This is *bold* text",
    );
  });

  it("converts italic markdown to Slack italic", () => {
    expect(markdownToMrkdwn("This is *italic* text")).toBe(
      "This is _italic_ text",
    );
  });

  it("converts strikethrough markdown to Slack strikethrough", () => {
    expect(markdownToMrkdwn("This is ~~struck~~ text")).toBe(
      "This is ~struck~ text",
    );
  });

  it("preserves fenced code blocks", () => {
    const input = "Before\n```\nconst x = **bold**;\n```\nAfter";
    const result = markdownToMrkdwn(input);
    expect(result).toContain("```\nconst x = **bold**;\n```");
    expect(result).toContain("Before");
    expect(result).toContain("After");
  });

  it("preserves inline code", () => {
    const input = "Use `**not bold**` for code";
    const result = markdownToMrkdwn(input);
    // The backtick content should be preserved exactly as-is
    expect(result).toBe("Use `**not bold**` for code");
  });

  it("handles multiple protected regions", () => {
    const input =
      "Run `npm install` then check ```\npackage.json\n``` and use `yarn` too";
    const result = markdownToMrkdwn(input);
    expect(result).toContain("`npm install`");
    expect(result).toContain("```\npackage.json\n```");
    expect(result).toContain("`yarn`");
  });

  it("handles mixed conversions", () => {
    const input =
      "## Setup\n\nInstall **dependencies** with `npm install`, then visit [docs](https://docs.example.com).\n\nThis is *important* and ~~deprecated~~.";
    const result = markdownToMrkdwn(input);
    expect(result).toContain("*Setup*");
    expect(result).toContain("*dependencies*");
    expect(result).toContain("`npm install`");
    expect(result).toContain("<https://docs.example.com|docs>");
    expect(result).toContain("_important_");
    expect(result).toContain("~deprecated~");
  });

  it("returns plain text unchanged", () => {
    const input = "Just a plain message with no formatting.";
    expect(markdownToMrkdwn(input)).toBe(input);
  });

  it("handles empty string", () => {
    expect(markdownToMrkdwn("")).toBe("");
  });
});
