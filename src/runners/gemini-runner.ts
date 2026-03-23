import { type LanguageModel, generateText } from "ai";

import type { AgentRunnerCodexClient } from "../agent/runner.js";
import type {
  CodexClientEvent,
  CodexTurnResult,
} from "../codex/app-server-client.js";
import { formatEasternTimestamp } from "../logging/format-timestamp.js";

export interface GeminiRunnerOptions {
  cwd: string;
  model: string;
  onEvent?: (event: CodexClientEvent) => void;
}

// Lazy-loaded provider — ai-sdk-provider-gemini-cli is ESM-only,
// require() returns an empty module. Dynamic import() is safe in all contexts.
let cachedProvider: ((model: string) => LanguageModel) | null = null;

async function getGeminiProvider(): Promise<(model: string) => LanguageModel> {
  if (cachedProvider) return cachedProvider;
  const { createGeminiProvider } = await import("ai-sdk-provider-gemini-cli");
  const provider = createGeminiProvider();
  cachedProvider = provider as (model: string) => LanguageModel;
  return cachedProvider;
}

export class GeminiRunner implements AgentRunnerCodexClient {
  private readonly options: GeminiRunnerOptions;
  private sessionId: string;
  private turnCount = 0;
  private closed = false;

  constructor(options: GeminiRunnerOptions) {
    this.options = options;
    this.sessionId = `gemini-${Date.now()}`;
  }

  async startSession(input: {
    prompt: string;
    title: string;
  }): Promise<CodexTurnResult> {
    return this.executeTurn(input.prompt, input.title);
  }

  async continueTurn(prompt: string, title: string): Promise<CodexTurnResult> {
    return this.executeTurn(prompt, title);
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  private async executeTurn(
    prompt: string,
    _title: string,
  ): Promise<CodexTurnResult> {
    this.turnCount += 1;
    const turnId = `turn-${this.turnCount}`;
    const threadId = this.sessionId;
    const fullSessionId = `${threadId}-${turnId}`;

    this.emit({
      event: "session_started",
      sessionId: fullSessionId,
      threadId,
      turnId,
    });

    try {
      const provider = await getGeminiProvider();
      const result = await generateText({
        model: provider(this.options.model),
        prompt,
      });

      const usage = {
        inputTokens: result.usage.inputTokens ?? 0,
        outputTokens: result.usage.outputTokens ?? 0,
        totalTokens: result.usage.totalTokens ?? 0,
      };

      this.emit({
        event: "turn_completed",
        sessionId: fullSessionId,
        threadId,
        turnId,
        usage,
        message: result.text,
      });

      return {
        status: "completed",
        threadId,
        turnId,
        sessionId: fullSessionId,
        usage,
        rateLimits: null,
        message: result.text,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Gemini turn failed";

      this.emit({
        event: "turn_failed",
        sessionId: fullSessionId,
        threadId,
        turnId,
        message,
      });

      return {
        status: "failed",
        threadId,
        turnId,
        sessionId: fullSessionId,
        usage: null,
        rateLimits: null,
        message,
      };
    }
  }

  private emit(
    input: Omit<CodexClientEvent, "timestamp" | "codexAppServerPid">,
  ): void {
    this.options.onEvent?.({
      ...input,
      timestamp: formatEasternTimestamp(new Date()),
      codexAppServerPid: null,
    });
  }
}
