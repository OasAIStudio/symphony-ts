import { rm } from "node:fs/promises";

import {
  CodexAppServerClient,
  type CodexClientEvent,
  type CodexDynamicTool,
  type CodexTurnResult,
} from "../codex/app-server-client.js";
import { createLinearGraphqlDynamicTool } from "../codex/linear-graphql-tool.js";
import { createWorkpadSyncDynamicTool } from "../codex/workpad-sync-tool.js";
import type {
  ResolvedWorkflowConfig,
  StageDefinition,
} from "../config/types.js";
import {
  type Issue,
  type LiveSession,
  type RunAttempt,
  type RunAttemptPhase,
  type Workspace,
  createEmptyLiveSession,
  normalizeIssueState,
  parseFailureSignal,
} from "../domain/model.js";
import { formatEasternTimestamp } from "../logging/format-timestamp.js";
import { applyCodexEventToSession } from "../logging/session-metrics.js";
import { createRunnerFromConfig, isAiSdkRunner } from "../runners/factory.js";
import type { RunnerKind } from "../runners/types.js";
import type { IssueTracker } from "../tracker/tracker.js";
import { WorkspaceHookRunner } from "../workspace/hooks.js";
import { validateWorkspaceCwd } from "../workspace/path-safety.js";
import { WorkspaceManager } from "../workspace/workspace-manager.js";
import {
  type BuildTurnPromptInput,
  buildTurnPrompt,
} from "./prompt-builder.js";

export interface AgentRunnerEvent extends CodexClientEvent {
  issueId: string;
  issueIdentifier: string;
  attempt: number | null;
  workspacePath: string;
  turnCount: number;
  promptChars?: number;
  estimatedPromptTokens?: number;
}

export interface AgentRunnerCodexClient {
  startSession(input: {
    prompt: string;
    title: string;
  }): Promise<CodexTurnResult>;
  continueTurn(prompt: string, title: string): Promise<CodexTurnResult>;
  close(): Promise<void>;
}

export interface AgentRunnerCodexClientFactoryInput {
  command: string;
  cwd: string;
  approvalPolicy: unknown;
  threadSandbox: unknown;
  turnSandboxPolicy: unknown;
  readTimeoutMs: number;
  turnTimeoutMs: number;
  stallTimeoutMs: number;
  dynamicTools: CodexDynamicTool[];
  onEvent: (event: CodexClientEvent) => void;
}

export interface AgentRunnerOptions {
  config: ResolvedWorkflowConfig;
  tracker: IssueTracker;
  workspaceManager?: WorkspaceManager;
  hooks?: WorkspaceHookRunner;
  createCodexClient?: (
    input: AgentRunnerCodexClientFactoryInput,
  ) => AgentRunnerCodexClient;
  fetchFn?: typeof fetch;
  onEvent?: (event: AgentRunnerEvent) => void;
}

export interface AgentRunInput {
  issue: Issue;
  attempt: number | null;
  signal?: AbortSignal;
  stage?: StageDefinition | null;
  stageName?: string | null;
  reworkCount?: number;
}

export interface AgentRunResult {
  issue: Issue;
  workspace: Workspace;
  runAttempt: RunAttempt;
  liveSession: LiveSession;
  turnsCompleted: number;
  lastTurn: CodexTurnResult | null;
  rateLimits: Record<string, unknown> | null;
}

export class AgentRunnerError extends Error {
  readonly code: string | undefined;
  readonly status: RunAttemptPhase;
  readonly failedPhase: RunAttemptPhase;
  readonly issue: Issue;
  readonly workspace: Workspace | null;
  readonly runAttempt: RunAttempt;
  readonly liveSession: LiveSession;

  constructor(input: {
    message: string;
    code?: string;
    status: RunAttemptPhase;
    failedPhase: RunAttemptPhase;
    issue: Issue;
    workspace: Workspace | null;
    runAttempt: RunAttempt;
    liveSession: LiveSession;
    cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = "AgentRunnerError";
    this.code = input.code;
    this.status = input.status;
    this.failedPhase = input.failedPhase;
    this.issue = input.issue;
    this.workspace = input.workspace;
    this.runAttempt = input.runAttempt;
    this.liveSession = input.liveSession;
  }
}

export class AgentRunner {
  private readonly config: ResolvedWorkflowConfig;

  private readonly tracker: IssueTracker;

  private readonly workspaceManager: WorkspaceManager;

  private readonly hooks: WorkspaceHookRunner;

  private readonly createCodexClient: (
    input: AgentRunnerCodexClientFactoryInput,
  ) => AgentRunnerCodexClient;

  private readonly fetchFn: typeof fetch | undefined;

  private readonly onEvent: ((event: AgentRunnerEvent) => void) | undefined;

  constructor(options: AgentRunnerOptions) {
    this.config = options.config;
    this.tracker = options.tracker;
    this.hooks =
      options.hooks ??
      new WorkspaceHookRunner({
        config: options.config.hooks,
      });
    this.workspaceManager =
      options.workspaceManager ??
      new WorkspaceManager({
        root: options.config.workspace.root,
        hooks: this.hooks,
      });
    this.createCodexClient =
      options.createCodexClient ??
      createDefaultClientFactory(
        options.config.runner.kind,
        options.config.runner.model,
      );
    this.fetchFn = options.fetchFn;
    this.onEvent = options.onEvent;
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    let issue = cloneIssue(input.issue);
    let workspace: Workspace | null = null;
    let client: AgentRunnerCodexClient | null = null;
    let lastTurn: CodexTurnResult | null = null;
    let rateLimits: Record<string, unknown> | null = null;
    const liveSession = createEmptyLiveSession();
    const runAttempt: RunAttempt = {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      attempt: input.attempt,
      workspacePath: "",
      startedAt: formatEasternTimestamp(new Date()),
      status: "preparing_workspace",
    };
    const abortController = createAgentAbortController(input.signal);

    // Resolve effective config from stage overrides, falling back to global
    const stage = input.stage ?? null;
    const effectiveRunnerKind = (stage?.runner ??
      this.config.runner.kind) as RunnerKind;
    const effectiveModel = stage?.model ?? this.config.runner.model;
    const effectiveMaxTurns = stage?.maxTurns ?? this.config.agent.maxTurns;
    const effectivePromptTemplate = stage?.prompt ?? this.config.promptTemplate;

    try {
      abortController.throwIfAborted({
        issue,
        workspace,
        runAttempt,
        liveSession,
      });

      // On fresh dispatch with stages at the initial stage, remove stale workspace
      // for a clean start.  For flat dispatch (no stages) or continuation attempts,
      // preserve the workspace so interrupted work survives restarts.
      if (
        input.attempt === null &&
        input.stageName !== null &&
        input.stageName === (this.config.stages?.initialStage ?? null)
      ) {
        try {
          await this.workspaceManager.removeForIssue(issue.id);
        } catch {
          // Best-effort: workspace may not exist
        }
      }

      workspace = await this.workspaceManager.createForIssue(issue.id);
      runAttempt.workspacePath = validateWorkspaceCwd({
        cwd: workspace.path,
        workspacePath: workspace.path,
        workspaceRoot: this.config.workspace.root,
      });
      await cleanupWorkspaceArtifacts(workspace.path);
      const workspacePath = workspace.path;

      console.warn(
        `[agent-runner] ${issue.identifier}: Using workspace path ${workspacePath}`,
      );

      await this.hooks.run({
        name: "beforeRun",
        workspacePath: workspace.path,
      });

      runAttempt.status = "launching_agent_process";
      let currentPromptChars = 0;
      let currentEstimatedPromptTokens = 0;
      const effectiveClientFactory = isAiSdkRunner(effectiveRunnerKind)
        ? (factoryInput: AgentRunnerCodexClientFactoryInput) =>
            createRunnerFromConfig({
              config: { kind: effectiveRunnerKind, model: effectiveModel },
              cwd: factoryInput.cwd,
              onEvent: factoryInput.onEvent,
            })
        : this.createCodexClient;
      client = effectiveClientFactory({
        command: this.config.codex.command,
        cwd: workspace.path,
        approvalPolicy: this.config.codex.approvalPolicy,
        threadSandbox: this.config.codex.threadSandbox,
        turnSandboxPolicy: this.config.codex.turnSandboxPolicy,
        readTimeoutMs: this.config.codex.readTimeoutMs,
        turnTimeoutMs: this.config.codex.turnTimeoutMs,
        stallTimeoutMs: this.config.codex.stallTimeoutMs,
        dynamicTools: this.createDynamicTools(),
        onEvent: (event) => {
          applyCodexEventToSession(liveSession, event);
          if (
            event.event === "session_started" &&
            "codexAppServerPid" in event
          ) {
            console.warn(
              `[agent-runner] ${issue.identifier}: CC process spawned with PID ${event.codexAppServerPid}`,
            );
          }
          this.onEvent?.({
            ...event,
            issueId: issue.id,
            issueIdentifier: issue.identifier,
            attempt: input.attempt,
            workspacePath,
            turnCount: liveSession.turnCount,
            promptChars: currentPromptChars,
            estimatedPromptTokens: currentEstimatedPromptTokens,
          });
        },
      });
      abortController.bindClient(client);

      for (
        let turnNumber = 1;
        turnNumber <= effectiveMaxTurns;
        turnNumber += 1
      ) {
        abortController.throwIfAborted({
          issue,
          workspace,
          runAttempt,
          liveSession,
        });
        runAttempt.status = "building_prompt";
        const prompt = await buildTurnPrompt({
          workflow: {
            promptTemplate: effectivePromptTemplate,
          },
          issue,
          attempt: input.attempt,
          stageName: input.stageName ?? null,
          reworkCount: input.reworkCount ?? 0,
          turnNumber,
          maxTurns: effectiveMaxTurns,
        });
        currentPromptChars = prompt.length;
        currentEstimatedPromptTokens = Math.ceil(prompt.length / 4);
        const title = `${issue.identifier}: ${issue.title}`;

        runAttempt.status =
          turnNumber === 1 ? "initializing_session" : "streaming_turn";
        lastTurn =
          turnNumber === 1
            ? await client.startSession({ prompt, title })
            : await client.continueTurn(prompt, title);
        rateLimits = lastTurn.rateLimits;

        applyCodexEventToSession(liveSession, {
          event:
            lastTurn.status === "completed"
              ? "turn_completed"
              : lastTurn.status === "failed"
                ? "turn_failed"
                : "turn_cancelled",
          timestamp: formatEasternTimestamp(new Date()),
          codexAppServerPid: liveSession.codexAppServerPid,
          sessionId: lastTurn.sessionId,
          threadId: lastTurn.threadId,
          turnId: lastTurn.turnId,
          ...(lastTurn.usage === null ? {} : { usage: lastTurn.usage }),
          ...(lastTurn.rateLimits === null
            ? {}
            : { rateLimits: lastTurn.rateLimits }),
          ...(lastTurn.message === null ? {} : { message: lastTurn.message }),
        });

        // Early exit: agent signaled stage completion or failure
        if (lastTurn.message?.trimEnd().endsWith("[STAGE_COMPLETE]")) {
          break;
        }
        if (
          lastTurn.message !== null &&
          parseFailureSignal(lastTurn.message) !== null
        ) {
          break;
        }

        // Turn failed at infrastructure level (e.g. abort/timeout) without an
        // explicit agent failure signal — propagate so the orchestrator sees
        // worker_exit_abnormal instead of the misleading worker_exit_normal.
        if (lastTurn.status !== "completed") {
          throw new AgentRunnerError({
            message: lastTurn.message ?? "Agent turn failed unexpectedly.",
            status: "failed",
            failedPhase: runAttempt.status,
            issue,
            // biome-ignore lint/style/noNonNullAssertion: workspace is assigned before this point in the run loop
            workspace: workspace!,
            runAttempt: { ...runAttempt },
            liveSession: { ...liveSession },
          });
        }

        runAttempt.status = "finishing";
        issue = await this.refreshIssueState(issue);
        if (!this.isIssueStillActive(issue)) {
          break;
        }
      }

      runAttempt.status = "succeeded";

      return {
        issue,
        workspace,
        runAttempt,
        liveSession,
        turnsCompleted: liveSession.turnCount,
        lastTurn,
        rateLimits,
      };
    } catch (error) {
      const wrapped = this.toAgentRunnerError({
        error,
        issue,
        workspace,
        runAttempt,
        liveSession,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      });
      runAttempt.status = wrapped.status;
      runAttempt.error = wrapped.message;
      throw wrapped;
    } finally {
      abortController.dispose();

      if (client !== null) {
        await closeBestEffort(client);
      }

      if (workspace !== null) {
        await this.hooks.runBestEffort({
          name: "afterRun",
          workspacePath: workspace.path,
        });
      }
    }
  }

  private createDynamicTools(): CodexDynamicTool[] {
    if (normalizeIssueState(this.config.tracker.kind ?? "") !== "linear") {
      return [];
    }

    const tools: CodexDynamicTool[] = [
      createLinearGraphqlDynamicTool({
        endpoint: this.config.tracker.endpoint,
        apiKey: this.config.tracker.apiKey,
        ...(this.fetchFn === undefined ? {} : { fetchFn: this.fetchFn }),
      }),
    ];

    if (this.config.tracker.apiKey !== null) {
      tools.push(
        createWorkpadSyncDynamicTool({
          apiKey: this.config.tracker.apiKey,
          endpoint: this.config.tracker.endpoint,
          ...(this.fetchFn === undefined ? {} : { fetchFn: this.fetchFn }),
        }),
      );
    }

    return tools;
  }

  private async refreshIssueState(issue: Issue): Promise<Issue> {
    const refreshed = await this.tracker.fetchIssueStatesByIds([issue.id]);
    const next = refreshed[0];

    if (next === undefined) {
      return issue;
    }

    return {
      ...issue,
      identifier:
        next.identifier.trim().length > 0 ? next.identifier : issue.identifier,
      state: next.state,
    };
  }

  private isIssueStillActive(issue: Issue): boolean {
    const activeStates = new Set(
      this.config.tracker.activeStates.map((state) =>
        normalizeIssueState(state),
      ),
    );
    return activeStates.has(normalizeIssueState(issue.state));
  }

  private toAgentRunnerError(input: {
    error: unknown;
    issue: Issue;
    workspace: Workspace | null;
    runAttempt: RunAttempt;
    liveSession: LiveSession;
    signal?: AbortSignal;
  }): AgentRunnerError {
    if (input.error instanceof AgentRunnerError) {
      return input.error;
    }

    if (input.signal?.aborted) {
      return new AgentRunnerError({
        message: toAbortMessage(input.signal.reason),
        status: "canceled_by_reconciliation",
        failedPhase: input.runAttempt.status,
        issue: input.issue,
        workspace: input.workspace,
        runAttempt: { ...input.runAttempt },
        liveSession: { ...input.liveSession },
        cause: input.error,
      });
    }

    const message =
      input.error instanceof Error ? input.error.message : "Agent run failed.";
    const code =
      typeof input.error === "object" &&
      input.error !== null &&
      "code" in input.error &&
      typeof input.error.code === "string"
        ? input.error.code
        : undefined;

    return new AgentRunnerError({
      message,
      ...(code === undefined ? {} : { code }),
      status: classifyFailureStatus(code),
      failedPhase: input.runAttempt.status,
      issue: input.issue,
      workspace: input.workspace,
      runAttempt: { ...input.runAttempt },
      liveSession: { ...input.liveSession },
      cause: input.error,
    });
  }
}

async function cleanupWorkspaceArtifacts(workspacePath: string): Promise<void> {
  await rm(`${workspacePath}/tmp`, {
    force: true,
    recursive: true,
  });
}

function createDefaultClientFactory(
  runnerKind: string,
  runnerModel: string | null = null,
): (input: AgentRunnerCodexClientFactoryInput) => AgentRunnerCodexClient {
  const kind = runnerKind as RunnerKind;

  if (isAiSdkRunner(kind)) {
    return (input) =>
      createRunnerFromConfig({
        config: { kind, model: runnerModel },
        cwd: input.cwd,
        onEvent: input.onEvent,
      });
  }

  return createDefaultCodexClient;
}

function createDefaultCodexClient(
  input: AgentRunnerCodexClientFactoryInput,
): AgentRunnerCodexClient {
  return new CodexAppServerClient({
    command: input.command,
    cwd: input.cwd,
    approvalPolicy: input.approvalPolicy,
    threadSandbox: input.threadSandbox,
    turnSandboxPolicy: input.turnSandboxPolicy,
    readTimeoutMs: input.readTimeoutMs,
    turnTimeoutMs: input.turnTimeoutMs,
    stallTimeoutMs: input.stallTimeoutMs,
    dynamicTools: input.dynamicTools,
    onEvent: input.onEvent,
  });
}

function classifyFailureStatus(code: string | undefined): RunAttemptPhase {
  if (code === "codex_turn_timeout" || code === "hook_timed_out") {
    return "timed_out";
  }

  if (code === "codex_session_stalled") {
    return "stalled";
  }

  return "failed";
}

async function closeBestEffort(client: AgentRunnerCodexClient): Promise<void> {
  try {
    await client.close();
  } catch {
    // Closing is cleanup-only here; preserve the primary failure cause.
  }
}

function cloneIssue(issue: Issue): Issue {
  return {
    ...issue,
    labels: [...issue.labels],
    blockedBy: issue.blockedBy.map((blocker) => ({ ...blocker })),
  };
}

function createAgentAbortController(signal: AbortSignal | undefined): {
  bindClient(client: AgentRunnerCodexClient): void;
  dispose(): void;
  throwIfAborted(input: {
    issue: Issue;
    workspace: Workspace | null;
    runAttempt: RunAttempt;
    liveSession: LiveSession;
  }): void;
} {
  let client: AgentRunnerCodexClient | null = null;
  let listener: (() => void) | null = null;

  const closeClient = () => {
    if (client === null) {
      return;
    }

    void closeBestEffort(client);
  };

  if (signal !== undefined) {
    listener = () => {
      closeClient();
    };
    signal.addEventListener("abort", listener, { once: true });
  }

  return {
    bindClient(nextClient) {
      client = nextClient;
      if (signal?.aborted) {
        closeClient();
      }
    },
    dispose() {
      if (signal !== undefined && listener !== null) {
        signal.removeEventListener("abort", listener);
      }
      listener = null;
      client = null;
    },
    throwIfAborted(input) {
      if (!signal?.aborted) {
        return;
      }

      throw new AgentRunnerError({
        message: toAbortMessage(signal.reason),
        status: "canceled_by_reconciliation",
        failedPhase: input.runAttempt.status,
        issue: input.issue,
        workspace: input.workspace,
        runAttempt: { ...input.runAttempt },
        liveSession: { ...input.liveSession },
      });
    },
  };
}

function toAbortMessage(reason: unknown): string {
  if (typeof reason === "string" && reason.trim().length > 0) {
    return reason.trim();
  }

  if (
    typeof reason === "object" &&
    reason !== null &&
    "message" in reason &&
    typeof reason.message === "string" &&
    reason.message.trim().length > 0
  ) {
    return reason.message.trim();
  }

  return "Agent run cancelled.";
}

export type { BuildTurnPromptInput };
