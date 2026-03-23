/**
 * Integration smoke tests for AI SDK provider runners.
 *
 * These tests call the real providers (claude-code, gemini-cli) with trivial
 * prompts and verify that output is returned. They require authenticated CLIs:
 *   - `claude` CLI (Claude Code Max subscription)
 *   - `gemini` CLI (Google paid subscription)
 *
 * Skipped by default — CI doesn't have auth'd CLIs.
 *
 * Run manually:
 *   npx vitest run tests/runners/integration-smoke.test.ts
 *
 * Or run a single provider:
 *   npx vitest run tests/runners/integration-smoke.test.ts -t "claude"
 *   npx vitest run tests/runners/integration-smoke.test.ts -t "gemini"
 */
import { describe, expect, it } from "vitest";

import { ClaudeCodeRunner } from "../../src/runners/claude-code-runner.js";
import { GeminiRunner } from "../../src/runners/gemini-runner.js";

const SKIP = process.env.RUN_INTEGRATION !== "1";

describe.skipIf(SKIP)("integration: AI SDK provider smoke tests", () => {
  it("claude-code runner returns text from a trivial prompt", async () => {
    const runner = new ClaudeCodeRunner({
      cwd: process.cwd(),
      model: "sonnet",
    });

    try {
      const result = await runner.startSession({
        prompt: 'Respond with exactly: "hello from claude"',
        title: "smoke-test",
      });

      expect(result.status).toBe("completed");
      expect(result.message).toBeTruthy();
      expect(typeof result.message).toBe("string");
      expect(result.usage).not.toBeNull();
      console.log(
        `  Claude response (${result.usage?.totalTokens ?? "?"} tokens): ${result.message?.slice(0, 100)}`,
      );
    } finally {
      await runner.close();
    }
  }, 60_000);

  it("claude-code runner maps full model IDs to short names", async () => {
    const runner = new ClaudeCodeRunner({
      cwd: process.cwd(),
      model: "claude-sonnet-4-5", // Should be mapped to "sonnet"
    });

    try {
      const result = await runner.startSession({
        prompt: 'Respond with exactly: "model id test"',
        title: "smoke-test-model-id",
      });

      expect(result.status).toBe("completed");
      expect(result.message).toBeTruthy();
      console.log(
        `  Claude (mapped model) response: ${result.message?.slice(0, 100)}`,
      );
    } finally {
      await runner.close();
    }
  }, 60_000);

  it("gemini runner returns text from a trivial prompt", async () => {
    const runner = new GeminiRunner({
      cwd: process.cwd(),
      model: "gemini-2.5-pro",
    });

    try {
      const result = await runner.startSession({
        prompt: 'Respond with exactly: "hello from gemini"',
        title: "smoke-test",
      });

      expect(result.status).toBe("completed");
      expect(result.message).toBeTruthy();
      expect(typeof result.message).toBe("string");
      expect(result.usage).not.toBeNull();
      console.log(
        `  Gemini response (${result.usage?.totalTokens ?? "?"} tokens): ${result.message?.slice(0, 100)}`,
      );
    } finally {
      await runner.close();
    }
  }, 60_000);
});
