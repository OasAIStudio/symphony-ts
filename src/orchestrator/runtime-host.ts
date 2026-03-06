import type { AgentRunResult, AgentRunnerEvent } from "../agent/runner.js";
import { AgentRunner } from "../agent/runner.js";
import type { ResolvedWorkflowConfig } from "../config/types.js";
import type { Issue, RetryEntry, RunningEntry } from "../domain/model.js";
import {
  type RuntimeSnapshot,
  buildRuntimeSnapshot,
} from "../logging/runtime-snapshot.js";
import type {
  DashboardServerHost,
  IssueDetailResponse,
  RefreshResponse,
} from "../observability/dashboard-server.js";
import type { IssueTracker } from "../tracker/tracker.js";
import { WorkspaceManager } from "../workspace/workspace-manager.js";
import type {
  OrchestratorCoreOptions,
  StopReason,
  StopRequest,
  TimerScheduler,
} from "./core.js";
import { OrchestratorCore } from "./core.js";

export interface AgentRunnerLike {
  run(input: {
    issue: Issue;
    attempt: number | null;
    signal?: AbortSignal;
  }): Promise<AgentRunResult>;
}

export interface RuntimeHostOptions {
  config: ResolvedWorkflowConfig;
  tracker: IssueTracker;
  agentRunner?: AgentRunnerLike;
  createAgentRunner?: (input: {
    onEvent: (event: AgentRunnerEvent) => void;
  }) => AgentRunnerLike;
  workspaceManager?: WorkspaceManager;
  now?: () => Date;
}

interface WorkerExecution {
  issueId: string;
  issueIdentifier: string;
  controller: AbortController;
  completion: Promise<void>;
  stopRequest: StopRequest | null;
  lastResult: AgentRunResult | null;
}

export class OrchestratorRuntimeHost implements DashboardServerHost {
  private readonly config: ResolvedWorkflowConfig;

  private readonly tracker: IssueTracker;

  private readonly workspaceManager: WorkspaceManager;

  private readonly agentRunner: AgentRunnerLike;

  private readonly now: () => Date;

  private readonly workers = new Map<string, WorkerExecution>();

  private readonly orchestrator: OrchestratorCore;

  private eventQueue: Promise<unknown> = Promise.resolve();

  private refreshQueued = false;

  constructor(options: RuntimeHostOptions) {
    this.config = options.config;
    this.tracker = options.tracker;
    this.now = options.now ?? (() => new Date());
    this.workspaceManager =
      options.workspaceManager ??
      new WorkspaceManager({
        root: options.config.workspace.root,
      });
    this.agentRunner =
      options.agentRunner ??
      options.createAgentRunner?.({
        onEvent: (event) => {
          void this.enqueue(async () => {
            this.orchestrator.onCodexEvent({
              issueId: event.issueId,
              event,
            });
          });
        },
      }) ??
      new AgentRunner({
        config: options.config,
        tracker: options.tracker,
        workspaceManager: this.workspaceManager,
        onEvent: (event) => {
          void this.enqueue(async () => {
            this.orchestrator.onCodexEvent({
              issueId: event.issueId,
              event,
            });
          });
        },
      });

    const timerScheduler = createQueuedTimerScheduler({
      run: (callback) => {
        void this.enqueue(async () => {
          callback();
        });
      },
    });

    const orchestratorOptions: OrchestratorCoreOptions = {
      config: options.config,
      tracker: options.tracker,
      now: this.now,
      timerScheduler,
      spawnWorker: async ({ issue, attempt }) =>
        this.spawnWorkerExecution(issue, attempt),
      stopRunningIssue: async (input) => {
        await this.stopWorkerExecution(input.issueId, {
          issueId: input.issueId,
          issueIdentifier: input.runningEntry.identifier,
          cleanupWorkspace: input.cleanupWorkspace,
          reason: input.reason,
        });
      },
    };

    this.orchestrator = new OrchestratorCore(orchestratorOptions);
  }

  getState() {
    return this.orchestrator.getState();
  }

  async pollOnce() {
    return this.enqueue(async () => this.orchestrator.pollTick());
  }

  async runRetryTimer(issueId: string) {
    return this.enqueue(async () => this.orchestrator.onRetryTimer(issueId));
  }

  async flushEvents(): Promise<void> {
    await this.eventQueue;
  }

  async waitForIdle(): Promise<void> {
    await this.eventQueue;
    await Promise.allSettled(
      [...this.workers.values()].map((worker) => worker.completion),
    );
    await this.eventQueue;
  }

  async getRuntimeSnapshot(): Promise<RuntimeSnapshot> {
    return buildRuntimeSnapshot(this.orchestrator.getState(), {
      now: this.now(),
    });
  }

  async getIssueDetails(
    issueIdentifier: string,
  ): Promise<IssueDetailResponse | null> {
    const running = Object.values(this.orchestrator.getState().running).find(
      (entry) => entry.identifier === issueIdentifier,
    );
    if (running !== undefined) {
      return toRunningIssueDetail(running);
    }

    const retry = Object.values(
      this.orchestrator.getState().retryAttempts,
    ).find((entry) => entry.identifier === issueIdentifier);
    if (retry !== undefined) {
      return toRetryIssueDetail(issueIdentifier, retry);
    }

    return null;
  }

  async requestRefresh(): Promise<RefreshResponse> {
    const requestedAt = this.now().toISOString();
    const coalesced = this.refreshQueued;
    this.refreshQueued = true;

    if (!coalesced) {
      void this.enqueue(async () => {
        this.refreshQueued = false;
        await this.orchestrator.pollTick();
      });
    }

    return {
      queued: true,
      coalesced,
      requested_at: requestedAt,
      operations: ["poll", "reconcile"],
    };
  }

  private async spawnWorkerExecution(
    issue: Issue,
    attempt: number | null,
  ): Promise<{
    workerHandle: WorkerExecution;
    monitorHandle: Promise<void>;
  }> {
    const controller = new AbortController();
    const execution: WorkerExecution = {
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      controller,
      stopRequest: null,
      lastResult: null,
      completion: Promise.resolve(),
    };

    const completion = this.agentRunner
      .run({
        issue,
        attempt,
        signal: controller.signal,
      })
      .then(async (result) => {
        execution.lastResult = result;
        await this.enqueue(async () => {
          await this.finalizeWorkerExecution(execution, {
            outcome: "normal",
            endedAt: this.now(),
          });
        });
      })
      .catch(async (error) => {
        await this.enqueue(async () => {
          await this.finalizeWorkerExecution(execution, {
            outcome: "abnormal",
            reason:
              execution.stopRequest === null
                ? toErrorMessage(error)
                : `stopped after ${execution.stopRequest.reason}`,
          });
        });
      });

    execution.completion = completion;
    this.workers.set(issue.id, execution);

    return {
      workerHandle: execution,
      monitorHandle: completion,
    };
  }

  private async stopWorkerExecution(
    issueId: string,
    input: StopRequest,
  ): Promise<void> {
    const execution = this.workers.get(issueId);
    if (execution === undefined) {
      return;
    }

    execution.stopRequest = input;
    execution.controller.abort(`Stopped due to ${input.reason}.`);
  }

  private async finalizeWorkerExecution(
    execution: WorkerExecution,
    input: {
      outcome: "normal" | "abnormal";
      reason?: string;
      endedAt?: Date;
    },
  ): Promise<void> {
    this.workers.delete(execution.issueId);

    if (execution.stopRequest?.cleanupWorkspace === true) {
      await this.workspaceManager.removeForIssue(execution.issueIdentifier);
    }

    this.orchestrator.onWorkerExit({
      issueId: execution.issueId,
      outcome: input.outcome,
      ...(input.reason === undefined ? {} : { reason: input.reason }),
      endedAt: input.endedAt ?? this.now(),
    });
  }

  private enqueue<T>(task: () => Promise<T> | T): Promise<T> {
    const next = this.eventQueue.then(task, task);
    this.eventQueue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }
}

function createQueuedTimerScheduler(input: {
  run: (callback: () => void) => void;
}): TimerScheduler {
  return {
    set(callback, delayMs) {
      return setTimeout(() => {
        input.run(callback);
      }, delayMs);
    },
    clear(handle) {
      if (handle !== null) {
        clearTimeout(handle);
      }
    },
  };
}

function toRunningIssueDetail(running: RunningEntry): IssueDetailResponse {
  return {
    issue_identifier: running.identifier,
    issue_id: running.issue.id,
    status: "running",
    workspace: {
      path: "",
    },
    attempts: {
      restart_count: running.retryAttempt ?? 0,
      current_retry_attempt: running.retryAttempt,
    },
    running: {
      session_id: running.sessionId,
      turn_count: running.turnCount,
      state: running.issue.state,
      started_at: running.startedAt,
      last_event: running.lastCodexEvent,
      last_message: running.lastCodexMessage,
      last_event_at: running.lastCodexTimestamp,
      tokens: {
        input_tokens: running.codexInputTokens,
        output_tokens: running.codexOutputTokens,
        total_tokens: running.codexTotalTokens,
      },
    },
    retry: null,
    logs: {
      codex_session_logs: [],
    },
    recent_events: [],
    last_error: null,
    tracked: {},
  };
}

function toRetryIssueDetail(
  issueIdentifier: string,
  retry: RetryEntry,
): IssueDetailResponse {
  return {
    issue_identifier: issueIdentifier,
    issue_id: retry.issueId,
    status: "retry_queued",
    workspace: null,
    attempts: {
      restart_count: retry.attempt,
      current_retry_attempt: retry.attempt,
    },
    running: null,
    retry: {
      attempt: retry.attempt,
      due_at: new Date(retry.dueAtMs).toISOString(),
      error: retry.error,
    },
    logs: {
      codex_session_logs: [],
    },
    recent_events: [],
    last_error: retry.error,
    tracked: {},
  };
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  return "worker failed";
}
