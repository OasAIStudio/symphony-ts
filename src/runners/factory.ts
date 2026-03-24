import type { AgentRunnerCodexClient } from "../agent/runner.js";
import { ClaudeCodeRunner } from "./claude-code-runner.js";
import { GeminiRunner } from "./gemini-runner.js";
import type { RunnerFactoryInput, RunnerKind } from "./types.js";

const DEFAULT_MODELS: Record<RunnerKind, string> = {
  codex: "codex",
  "claude-code": "sonnet",
  gemini: "gemini-2.5-pro",
};

export function createRunnerFromConfig(
  input: RunnerFactoryInput,
): AgentRunnerCodexClient {
  const { config, cwd, onEvent } = input;
  const model = config.model ?? DEFAULT_MODELS[config.kind];

  switch (config.kind) {
    case "claude-code":
      return new ClaudeCodeRunner({
        cwd,
        model,
        onEvent,
      });

    case "gemini":
      return new GeminiRunner({
        cwd,
        model,
        onEvent,
      });

    case "codex":
      throw new Error(
        "Codex runner uses the native CodexAppServerClient — use createCodexClient instead of createRunnerFromConfig for runner kind 'codex'.",
      );
  }
}

export function isAiSdkRunner(kind: RunnerKind): boolean {
  return kind !== "codex";
}
