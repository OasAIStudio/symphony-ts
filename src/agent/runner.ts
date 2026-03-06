import {
  CodexAppServerClient,
  type CodexClientEvent,
  type CodexDynamicTool,
  type CodexTurnResult,
} from "../codex/app-server-client.js";
import { createLinearGraphqlDynamicTool } from "../codex/linear-graphql-tool.js";
import type { ResolvedWorkflowConfig } from "../config/types.js";
import {
  type Issue,
  type LiveSession,
  type RunAttempt,
  type RunAttemptPhase,
  type Workspace,
  createEmptyLiveSession,
  normalizeIssueState,
} from "../domain/model.js";
import { applyCodexEventToSession } from "../logging/session-metrics.js";
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
      options.createCodexClient ?? createDefaultCodexClient;
    this.fetchFn = options.fetchFn;
    this.onEvent = options.onEvent;
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    let issue = cloneIssue(input.issue);
    let workspace: Workspace | null = null;
    let client: AgentRunnerCodexClient | null = null;
    let shouldRunAfterHook = false;
    let lastTurn: CodexTurnResult | null = null;
    let rateLimits: Record<string, unknown> | null = null;
    const liveSession = createEmptyLiveSession();
    const runAttempt: RunAttempt = {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      attempt: input.attempt,
      workspacePath: "",
      startedAt: new Date().toISOString(),
      status: "preparing_workspace",
    };

    try {
      workspace = await this.workspaceManager.createForIssue(issue.identifier);
      runAttempt.workspacePath = validateWorkspaceCwd({
        cwd: workspace.path,
        workspacePath: workspace.path,
        workspaceRoot: this.config.workspace.root,
      });
      const workspacePath = workspace.path;

      await this.hooks.run({
        name: "beforeRun",
        workspacePath: workspace.path,
      });
      shouldRunAfterHook = true;

      runAttempt.status = "launching_agent_process";
      client = this.createCodexClient({
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
          this.onEvent?.({
            ...event,
            issueId: issue.id,
            issueIdentifier: issue.identifier,
            attempt: input.attempt,
            workspacePath,
            turnCount: liveSession.turnCount,
          });
        },
      });

      for (
        let turnNumber = 1;
        turnNumber <= this.config.agent.maxTurns;
        turnNumber += 1
      ) {
        runAttempt.status = "building_prompt";
        const prompt = await buildTurnPrompt({
          workflow: {
            promptTemplate: this.config.promptTemplate,
          },
          issue,
          attempt: input.attempt,
          turnNumber,
          maxTurns: this.config.agent.maxTurns,
        });
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
          timestamp: new Date().toISOString(),
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
      });
      runAttempt.status = wrapped.status;
      runAttempt.error = wrapped.message;
      throw wrapped;
    } finally {
      if (client !== null) {
        await closeBestEffort(client);
      }

      if (shouldRunAfterHook && workspace !== null) {
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

    return [
      createLinearGraphqlDynamicTool({
        endpoint: this.config.tracker.endpoint,
        apiKey: this.config.tracker.apiKey,
        ...(this.fetchFn === undefined ? {} : { fetchFn: this.fetchFn }),
      }),
    ];
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
  }): AgentRunnerError {
    if (input.error instanceof AgentRunnerError) {
      return input.error;
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

export type { BuildTurnPromptInput };
