import { describe, expect, it, vi } from "vitest";

import type { CodexClientEvent } from "../../src/codex/app-server-client.js";
import { ClaudeCodeRunner } from "../../src/runners/claude-code-runner.js";
import {
  createRunnerFromConfig,
  isAiSdkRunner,
} from "../../src/runners/factory.js";
import { GeminiRunner } from "../../src/runners/gemini-runner.js";
import type { RunnerKind } from "../../src/runners/types.js";
import { RUNNER_KINDS } from "../../src/runners/types.js";

vi.mock("ai", () => ({
  generateText: vi.fn(),
}));

vi.mock("ai-sdk-provider-claude-code", () => ({
  claudeCode: vi.fn(() => "mock-claude-model"),
}));

vi.mock("ai-sdk-provider-gemini-cli", () => ({
  createGeminiProvider: vi.fn(() => vi.fn()),
}));

describe("createRunnerFromConfig", () => {
  it("creates ClaudeCodeRunner for kind 'claude-code'", () => {
    const onEvent = vi.fn();
    const runner = createRunnerFromConfig({
      config: { kind: "claude-code", model: "opus" },
      cwd: "/tmp/workspace",
      onEvent,
    });

    expect(runner).toBeInstanceOf(ClaudeCodeRunner);
  });

  it("creates GeminiRunner for kind 'gemini'", () => {
    const onEvent = vi.fn();
    const runner = createRunnerFromConfig({
      config: { kind: "gemini", model: "gemini-2.5-pro" },
      cwd: "/tmp/workspace",
      onEvent,
    });

    expect(runner).toBeInstanceOf(GeminiRunner);
  });

  it("throws for kind 'codex'", () => {
    expect(() =>
      createRunnerFromConfig({
        config: { kind: "codex", model: null },
        cwd: "/tmp/workspace",
        onEvent: vi.fn(),
      }),
    ).toThrow("Codex runner uses the native CodexAppServerClient");
  });

  it("uses default model when model is null", () => {
    const runner = createRunnerFromConfig({
      config: { kind: "claude-code", model: null },
      cwd: "/tmp/workspace",
      onEvent: vi.fn(),
    });

    // Default model for claude-code is "sonnet"
    expect(runner).toBeInstanceOf(ClaudeCodeRunner);
  });
});

describe("isAiSdkRunner", () => {
  it("returns true for claude-code", () => {
    expect(isAiSdkRunner("claude-code")).toBe(true);
  });

  it("returns true for gemini", () => {
    expect(isAiSdkRunner("gemini")).toBe(true);
  });

  it("returns false for codex", () => {
    expect(isAiSdkRunner("codex")).toBe(false);
  });
});

describe("RUNNER_KINDS", () => {
  it("contains all supported runner kinds", () => {
    expect(RUNNER_KINDS).toEqual(["codex", "claude-code", "gemini"]);
  });
});
