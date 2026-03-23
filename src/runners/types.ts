import type { AgentRunnerCodexClient } from "../agent/runner.js";
import type { CodexClientEvent } from "../codex/app-server-client.js";

export type RunnerKind = "codex" | "claude-code" | "gemini";

export const RUNNER_KINDS: readonly RunnerKind[] = [
  "codex",
  "claude-code",
  "gemini",
] as const;

export interface RunnerConfig {
  kind: RunnerKind;
  model: string | null;
}

export interface RunnerFactoryInput {
  config: RunnerConfig;
  cwd: string;
  onEvent: (event: CodexClientEvent) => void;
}

export type { AgentRunnerCodexClient as Runner };
export type RunnerFactory = (
  input: RunnerFactoryInput,
) => AgentRunnerCodexClient;
