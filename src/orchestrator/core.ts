import type { CodexClientEvent } from "../codex/app-server-client.js";
import { validateDispatchConfig } from "../config/config-resolver.js";
import type {
  DispatchValidationResult,
  ResolvedWorkflowConfig,
  StageDefinition,
} from "../config/types.js";
import {
  type FailureClass,
  type Issue,
  type OrchestratorState,
  type RetryEntry,
  type RunningEntry,
  type StageRecord,
  createEmptyLiveSession,
  createInitialOrchestratorState,
  normalizeIssueState,
  parseFailureSignal,
} from "../domain/model.js";
import { formatEasternTimestamp } from "../logging/format-timestamp.js";
import {
  addEndedSessionRuntime,
  applyCodexEventToOrchestratorState,
} from "../logging/session-metrics.js";
import type { IssueStateSnapshot, IssueTracker } from "../tracker/tracker.js";
import {
  type EnsembleGateResult,
  formatExecutionReport,
  formatReviewFindingsComment,
} from "./gate-handler.js";

const CONTINUATION_RETRY_DELAY_MS = 1_000;
const FAILURE_RETRY_BASE_DELAY_MS = 10_000;

export type WorkerExitOutcome = "normal" | "abnormal";

export type StopReason = "terminal_state" | "inactive_state" | "stall_timeout";

export interface SpawnWorkerResult {
  workerHandle: unknown;
  monitorHandle: unknown;
}

export interface StopRequest {
  issueId: string;
  issueIdentifier: string;
  cleanupWorkspace: boolean;
  reason: StopReason;
}

export interface PollTickResult {
  validation: DispatchValidationResult;
  dispatchedIssueIds: string[];
  stopRequests: StopRequest[];
  trackerFetchFailed: boolean;
  reconciliationFetchFailed: boolean;
  runningCount: number;
}

export interface RetryTimerResult {
  dispatched: boolean;
  released: boolean;
  retryEntry: RetryEntry | null;
}

export interface CodexEventResult {
  applied: boolean;
}

export interface TimerScheduler {
  set(
    callback: () => void,
    delayMs: number,
  ): ReturnType<typeof setTimeout> | null;
  clear(handle: ReturnType<typeof setTimeout> | null): void;
}

export interface OrchestratorCoreOptions {
  config: ResolvedWorkflowConfig;
  tracker: IssueTracker;
  spawnWorker: (input: {
    issue: Issue;
    attempt: number | null;
    stage: StageDefinition | null;
    stageName: string | null;
    reworkCount: number;
  }) => Promise<SpawnWorkerResult> | SpawnWorkerResult;
  stopRunningIssue?: (input: {
    issueId: string;
    runningEntry: RunningEntry;
    cleanupWorkspace: boolean;
    reason: StopReason;
  }) => Promise<void> | void;
  runEnsembleGate?: (input: {
    issue: Issue;
    stage: StageDefinition;
  }) => Promise<EnsembleGateResult>;
  postComment?: (issueId: string, body: string) => Promise<void>;
  updateIssueState?: (
    issueId: string,
    issueIdentifier: string,
    stateName: string,
  ) => Promise<void>;
  timerScheduler?: TimerScheduler;
  now?: () => Date;
}

export class OrchestratorCore {
  private config: ResolvedWorkflowConfig;

  private tracker: IssueTracker;

  private readonly spawnWorker: OrchestratorCoreOptions["spawnWorker"];

  private readonly stopRunningIssue?: OrchestratorCoreOptions["stopRunningIssue"];

  private readonly runEnsembleGate?: OrchestratorCoreOptions["runEnsembleGate"];

  private readonly postComment?: OrchestratorCoreOptions["postComment"];

  private readonly updateIssueState?: OrchestratorCoreOptions["updateIssueState"];

  private readonly timerScheduler: TimerScheduler;

  private readonly now: () => Date;

  private readonly state: OrchestratorState;

  constructor(options: OrchestratorCoreOptions) {
    this.config = options.config;
    this.tracker = options.tracker;
    this.spawnWorker = options.spawnWorker;
    this.stopRunningIssue = options.stopRunningIssue;
    this.runEnsembleGate = options.runEnsembleGate;
    this.postComment = options.postComment;
    this.updateIssueState = options.updateIssueState;
    this.timerScheduler = options.timerScheduler ?? defaultTimerScheduler();
    this.now = options.now ?? (() => new Date());
    this.state = createInitialOrchestratorState({
      pollIntervalMs: options.config.polling.intervalMs,
      maxConcurrentAgents: options.config.agent.maxConcurrentAgents,
    });
  }

  getState(): OrchestratorState {
    return this.state;
  }

  updateConfig(config: ResolvedWorkflowConfig): void {
    this.config = config;
    this.syncStateFromConfig();
  }

  updateTracker(tracker: IssueTracker): void {
    this.tracker = tracker;
  }

  isDispatchEligible(
    issue: Issue,
    options?: {
      allowClaimedIssueId?: string;
    },
  ): boolean {
    if (
      issue.id.trim() === "" ||
      issue.identifier.trim() === "" ||
      issue.title.trim() === "" ||
      issue.state.trim() === ""
    ) {
      return false;
    }

    const normalizedState = normalizeIssueState(issue.state);
    const activeStates = toNormalizedStateSet(this.config.tracker.activeStates);
    const terminalStates = toNormalizedStateSet(
      this.config.tracker.terminalStates,
    );
    if (
      !activeStates.has(normalizedState) ||
      terminalStates.has(normalizedState) ||
      this.state.running[issue.id] !== undefined
    ) {
      return false;
    }

    // Allow resumed issues: clear completed flag ONLY when a human has
    // explicitly moved the issue to a resume-designated state ("Resume" or
    // "Todo").  Issues still in operational states like "In Progress" or
    // "In Review" stay completed — they haven't been deliberately requeued.
    // Issues in the escalation state ("Blocked") also stay completed until
    // a human explicitly moves them.
    if (this.state.completed.has(issue.id)) {
      const resumeStates: ReadonlySet<string> = new Set(["resume", "todo"]);
      if (resumeStates.has(normalizedState)) {
        this.state.completed.delete(issue.id);
      } else {
        return false;
      }
    }

    const allowClaimedIssueId = options?.allowClaimedIssueId;
    if (
      this.state.claimed.has(issue.id) &&
      (allowClaimedIssueId === undefined || allowClaimedIssueId !== issue.id)
    ) {
      return false;
    }

    if (
      this.availableSlots() <= 0 ||
      this.availableSlotsForState(issue.state) <= 0
    ) {
      return false;
    }

    return issue.blockedBy.every((blocker) => {
      const blockerState =
        blocker.state === null ? null : normalizeIssueState(blocker.state);
      return blockerState !== null && terminalStates.has(blockerState);
    });
  }

  async pollTick(): Promise<PollTickResult> {
    this.syncStateFromConfig();

    const reconcileResult = await this.reconcileRunningIssues();
    const validation = validateDispatchConfig(this.config);
    if (!validation.ok) {
      return {
        validation,
        dispatchedIssueIds: [],
        stopRequests: reconcileResult.stopRequests,
        trackerFetchFailed: false,
        reconciliationFetchFailed: reconcileResult.reconciliationFetchFailed,
        runningCount: Object.keys(this.state.running).length,
      };
    }

    let issues: Issue[];
    try {
      issues = await this.tracker.fetchCandidateIssues();
    } catch {
      return {
        validation,
        dispatchedIssueIds: [],
        stopRequests: reconcileResult.stopRequests,
        trackerFetchFailed: true,
        reconciliationFetchFailed: reconcileResult.reconciliationFetchFailed,
        runningCount: Object.keys(this.state.running).length,
      };
    }

    // Check for pipeline-halt before dispatching
    const haltIssue = await this.checkPipelineHalt();
    if (haltIssue !== null) {
      console.warn(
        `[orchestrator] Pipeline halted: ${haltIssue.identifier} — ${haltIssue.title}. Skipping all dispatch.`,
      );
      return {
        validation,
        dispatchedIssueIds: [],
        stopRequests: reconcileResult.stopRequests,
        trackerFetchFailed: false,
        reconciliationFetchFailed: reconcileResult.reconciliationFetchFailed,
        runningCount: Object.keys(this.state.running).length,
      };
    }

    const dispatchedIssueIds: string[] = [];
    for (const issue of sortIssuesForDispatch(issues)) {
      if (this.availableSlots() <= 0) {
        break;
      }

      if (!this.isDispatchEligible(issue)) {
        continue;
      }

      const dispatched = await this.dispatchIssue(issue, null);
      if (dispatched) {
        dispatchedIssueIds.push(issue.id);
      }
    }

    return {
      validation,
      dispatchedIssueIds,
      stopRequests: reconcileResult.stopRequests,
      trackerFetchFailed: false,
      reconciliationFetchFailed: reconcileResult.reconciliationFetchFailed,
      runningCount: Object.keys(this.state.running).length,
    };
  }

  async onRetryTimer(issueId: string): Promise<RetryTimerResult> {
    const retryEntry = this.state.retryAttempts[issueId];
    if (retryEntry === undefined) {
      return {
        dispatched: false,
        released: false,
        retryEntry: null,
      };
    }

    // Check for pipeline-halt before dispatching — fail-open on errors
    const haltIssue = await this.checkPipelineHalt();
    if (haltIssue !== null) {
      console.warn(
        `[orchestrator] Pipeline halted: ${haltIssue.identifier} — ${haltIssue.title}. Deferring retry for ${retryEntry.identifier ?? issueId}.`,
      );
      // Don't consume the retry attempt — reschedule at the same attempt number
      this.clearRetryEntry(issueId);
      return {
        dispatched: false,
        released: false,
        retryEntry: this.scheduleRetry(issueId, retryEntry.attempt, {
          identifier: retryEntry.identifier,
          error: `pipeline halted: ${haltIssue.identifier}`,
          delayType: retryEntry.delayType,
        }),
      };
    }

    this.clearRetryEntry(issueId);

    let candidates: Issue[];
    try {
      candidates = await this.tracker.fetchCandidateIssues();
    } catch {
      return {
        dispatched: false,
        released: false,
        retryEntry: this.scheduleRetry(issueId, retryEntry.attempt + 1, {
          identifier: retryEntry.identifier,
          error: "retry poll failed",
          delayType: retryEntry.delayType,
        }),
      };
    }

    const issue =
      candidates.find((candidate) => candidate.id === issueId) ?? null;
    if (issue === null) {
      this.releaseClaim(issueId);
      return {
        dispatched: false,
        released: true,
        retryEntry: null,
      };
    }

    if (!this.isRetryCandidateEligible(issue)) {
      this.releaseClaim(issueId);
      return {
        dispatched: false,
        released: true,
        retryEntry: null,
      };
    }

    if (
      this.availableSlots() <= 0 ||
      this.availableSlotsForState(issue.state) <= 0
    ) {
      return {
        dispatched: false,
        released: false,
        retryEntry: this.scheduleRetry(issueId, retryEntry.attempt + 1, {
          identifier: issue.identifier,
          error: "no available orchestrator slots",
          delayType: retryEntry.delayType,
        }),
      };
    }

    const dispatched = await this.dispatchIssue(issue, retryEntry.attempt);
    return {
      dispatched,
      released: false,
      retryEntry: null,
    };
  }

  onWorkerExit(input: {
    issueId: string;
    outcome: WorkerExitOutcome;
    reason?: string;
    endedAt?: Date;
    agentMessage?: string;
  }): RetryEntry | null {
    const runningEntry = this.state.running[input.issueId];
    if (runningEntry === undefined) {
      return null;
    }

    delete this.state.running[input.issueId];
    const endedAt = input.endedAt ?? this.now();
    addEndedSessionRuntime(this.state, runningEntry.startedAt, endedAt);

    // Append a StageRecord to execution history for this completed stage.
    const stageName = this.state.issueStages[input.issueId];
    if (stageName !== undefined) {
      const stageRecord: StageRecord = {
        stageName,
        durationMs: endedAt.getTime() - Date.parse(runningEntry.startedAt),
        totalTokens: runningEntry.totalStageTotalTokens,
        turns: runningEntry.turnCount,
        outcome: input.outcome,
      };
      let history = this.state.issueExecutionHistory[input.issueId];
      if (history === undefined) {
        history = [];
        this.state.issueExecutionHistory[input.issueId] = history;
      }
      history.push(stageRecord);
    }

    if (input.outcome === "normal") {
      const failureSignal = parseFailureSignal(input.agentMessage);
      if (failureSignal !== null) {
        return this.handleFailureSignal(
          input.issueId,
          runningEntry,
          failureSignal.failureClass,
          input.agentMessage,
        );
      }

      const transition = this.advanceStage(
        input.issueId,
        runningEntry.identifier,
      );
      if (transition === "completed") {
        this.state.completed.add(input.issueId);
        this.releaseClaim(input.issueId);
        return null;
      }

      // Stage advanced or no stages configured — schedule continuation
      this.state.completed.add(input.issueId);
      return this.scheduleRetry(input.issueId, 1, {
        identifier: runningEntry.identifier,
        error: null,
        delayType: "continuation",
      });
    }

    return this.scheduleRetry(
      input.issueId,
      nextRetryAttempt(runningEntry.retryAttempt),
      {
        identifier: runningEntry.identifier,
        error: formatWorkerExitReason(input.reason),
        delayType: "failure",
      },
    );
  }

  /**
   * Advance issue to next stage based on transition rules.
   * Returns "completed" if the issue reached a terminal stage,
   * "advanced" if it moved to the next stage, or "unchanged" if
   * no stages are configured.
   *
   * When reaching a terminal stage that has a linearState configured,
   * fires updateIssueState as a best-effort side effect so the
   * tracker reflects the final state (e.g., "Done").
   */
  private advanceStage(
    issueId: string,
    issueIdentifier: string,
  ): "completed" | "advanced" | "unchanged" {
    const stagesConfig = this.config.stages;
    if (stagesConfig === null) {
      return "unchanged";
    }

    const currentStageName = this.state.issueStages[issueId];
    if (currentStageName === undefined) {
      return "unchanged";
    }

    const currentStage = stagesConfig.stages[currentStageName];
    if (currentStage === undefined) {
      return "unchanged";
    }

    const nextStageName = currentStage.transitions.onComplete;
    if (nextStageName === null) {
      // No on_complete transition — treat as terminal
      delete this.state.issueStages[issueId];
      delete this.state.issueReworkCounts[issueId];
      delete this.state.issueExecutionHistory[issueId];
      delete this.state.issueFirstDispatchedAt[issueId];
      return "completed";
    }

    const nextStage = stagesConfig.stages[nextStageName];
    if (nextStage === undefined) {
      // Invalid target — treat as terminal
      delete this.state.issueStages[issueId];
      delete this.state.issueReworkCounts[issueId];
      delete this.state.issueExecutionHistory[issueId];
      delete this.state.issueFirstDispatchedAt[issueId];
      return "completed";
    }

    if (nextStage.type === "terminal") {
      // Post execution report before cleanup (best-effort)
      if (nextStage.linearState !== null && this.postComment !== undefined) {
        const history = this.state.issueExecutionHistory[issueId] ?? [];
        const reworkCount = this.state.issueReworkCounts[issueId] ?? 0;
        const report = formatExecutionReport(
          issueIdentifier,
          history,
          reworkCount,
        );
        void this.postComment(issueId, report).catch((err) => {
          console.warn(
            `[orchestrator] Failed to post execution report for ${issueIdentifier}:`,
            err,
          );
        });
      }
      delete this.state.issueStages[issueId];
      delete this.state.issueReworkCounts[issueId];
      delete this.state.issueExecutionHistory[issueId];
      delete this.state.issueFirstDispatchedAt[issueId];
      // Fire linearState update for the terminal stage (e.g., move to "Done")
      if (
        nextStage.linearState !== null &&
        this.updateIssueState !== undefined
      ) {
        void this.updateIssueState(
          issueId,
          issueIdentifier,
          nextStage.linearState,
        ).catch((err) => {
          console.warn(
            `[orchestrator] Failed to update terminal state for ${issueIdentifier}:`,
            err,
          );
        });
      }
      return "completed";
    }

    // Move to the next stage
    this.state.issueStages[issueId] = nextStageName;
    return "advanced";
  }

  /**
   * Handle agent-reported failure signals parsed from output.
   * Routes to retry, rework, or escalation based on failure class.
   */
  private handleFailureSignal(
    issueId: string,
    runningEntry: RunningEntry,
    failureClass: FailureClass,
    agentMessage: string | undefined,
  ): RetryEntry | null {
    if (failureClass === "spec") {
      // Spec failures are unrecoverable — escalate immediately
      this.state.completed.add(issueId);
      this.releaseClaim(issueId);
      delete this.state.issueStages[issueId];
      delete this.state.issueReworkCounts[issueId];
      delete this.state.issueExecutionHistory[issueId];
      delete this.state.issueFirstDispatchedAt[issueId];
      void this.fireEscalationSideEffects(
        issueId,
        runningEntry.identifier,
        "Agent reported unrecoverable spec failure. Escalating for manual review.",
      );
      return null;
    }

    if (failureClass === "verify" || failureClass === "infra") {
      // Retryable failures — use existing exponential backoff
      return this.scheduleRetry(
        issueId,
        nextRetryAttempt(runningEntry.retryAttempt),
        {
          identifier: runningEntry.identifier,
          error: `agent reported failure: ${failureClass}`,
          delayType: "failure",
        },
      );
    }

    // failureClass === "review" — trigger rework via gate lookup
    return this.handleReviewFailure(issueId, runningEntry, agentMessage);
  }

  /**
   * Handle review failure: find the downstream gate and use its rework target.
   * Falls back to retry if no gate or rework target is found.
   * Posts a review findings comment before triggering rework.
   */
  private handleReviewFailure(
    issueId: string,
    runningEntry: RunningEntry,
    agentMessage: string | undefined,
  ): RetryEntry | null {
    const stagesConfig = this.config.stages;
    if (stagesConfig === null) {
      // No stages — fall back to retry
      return this.scheduleRetry(
        issueId,
        nextRetryAttempt(runningEntry.retryAttempt),
        {
          identifier: runningEntry.identifier,
          error: "agent reported failure: review",
          delayType: "failure",
        },
      );
    }

    const currentStageName = this.state.issueStages[issueId];
    if (currentStageName === undefined) {
      return this.scheduleRetry(
        issueId,
        nextRetryAttempt(runningEntry.retryAttempt),
        {
          identifier: runningEntry.identifier,
          error: "agent reported failure: review",
          delayType: "failure",
        },
      );
    }

    // Check if the current stage itself has onRework (agent-type review stages)
    const currentStage = stagesConfig.stages[currentStageName];
    if (
      currentStage !== undefined &&
      currentStage.type === "agent" &&
      currentStage.transitions.onRework !== null
    ) {
      // Use reworkGate directly — it now supports agent stages with onRework
      const reworkTarget = this.reworkGate(issueId);
      if (reworkTarget === "escalated") {
        void this.fireEscalationSideEffects(
          issueId,
          runningEntry.identifier,
          "Agent review failure: max rework attempts exceeded. Escalating for manual review.",
        );
        return null;
      }
      if (reworkTarget !== null) {
        this.postReviewFindingsComment(
          issueId,
          runningEntry.identifier,
          currentStageName,
          agentMessage,
        );
        return this.scheduleRetry(issueId, 1, {
          identifier: runningEntry.identifier,
          error: `agent review failure: rework to ${reworkTarget}`,
          delayType: "continuation",
        });
      }
      // reworkTarget === null should not happen since we checked onRework !== null,
      // but fall through to downstream gate search just in case
    }

    // Walk from current stage's onComplete to find the next gate
    const gateName = this.findDownstreamGate(currentStageName);
    if (gateName === null) {
      return this.scheduleRetry(
        issueId,
        nextRetryAttempt(runningEntry.retryAttempt),
        {
          identifier: runningEntry.identifier,
          error: "agent reported failure: review",
          delayType: "failure",
        },
      );
    }

    // Use the gate's rework logic (reuses reworkGate by temporarily setting stage)
    // biome-ignore lint/style/noNonNullAssertion: issueId is guaranteed to exist in issueStages at this point
    const savedStage = this.state.issueStages[issueId]!;
    this.state.issueStages[issueId] = gateName;
    let reworkTarget: string | "escalated" | null;
    try {
      reworkTarget = this.reworkGate(issueId);
    } catch (err) {
      this.state.issueStages[issueId] = savedStage;
      throw err;
    }
    if (reworkTarget === null) {
      // No rework target — restore and fall back to retry
      this.state.issueStages[issueId] = savedStage;
      return this.scheduleRetry(
        issueId,
        nextRetryAttempt(runningEntry.retryAttempt),
        {
          identifier: runningEntry.identifier,
          error:
            "agent reported failure: review (no rework target on downstream gate)",
          delayType: "failure",
        },
      );
    }

    if (reworkTarget === "escalated") {
      // reworkGate already cleaned up state — fire escalation side effects
      void this.fireEscalationSideEffects(
        issueId,
        runningEntry.identifier,
        "Agent review failure: max rework attempts exceeded. Escalating for manual review.",
      );
      return null;
    }

    // Rework target set by reworkGate — post findings and schedule continuation
    this.postReviewFindingsComment(
      issueId,
      runningEntry.identifier,
      currentStageName,
      agentMessage,
    );
    return this.scheduleRetry(issueId, 1, {
      identifier: runningEntry.identifier,
      error: `agent review failure: rework to ${reworkTarget}`,
      delayType: "continuation",
    });
  }

  /**
   * Post a review findings comment as a best-effort side effect.
   * Uses void...catch pattern to never affect pipeline flow.
   */
  private postReviewFindingsComment(
    issueId: string,
    issueIdentifier: string,
    stageName: string,
    agentMessage: string | undefined,
  ): void {
    if (this.postComment === undefined) {
      return;
    }
    const comment = formatReviewFindingsComment(
      issueIdentifier,
      stageName,
      agentMessage ?? "",
    );
    void this.postComment(issueId, comment).catch((err) => {
      console.warn(
        `[orchestrator] Failed to post review findings comment for ${issueIdentifier}:`,
        err,
      );
    });
  }

  /**
   * Walk from a stage's onComplete transition to find the next gate stage.
   * Returns the gate stage name or null if none found.
   */
  private findDownstreamGate(startStageName: string): string | null {
    const stagesConfig = this.config.stages;
    if (stagesConfig === null) {
      return null;
    }

    const visited = new Set<string>();
    let current = startStageName;

    while (!visited.has(current)) {
      visited.add(current);
      const stage = stagesConfig.stages[current];
      if (stage === undefined) {
        return null;
      }

      const next = stage.transitions.onComplete;
      if (next === null) {
        return null;
      }

      const nextStage = stagesConfig.stages[next];
      if (nextStage === undefined) {
        return null;
      }

      if (nextStage.type === "gate") {
        return next;
      }

      // Agent-type stages with onRework can also serve as rework gates
      if (
        nextStage.type === "agent" &&
        nextStage.transitions.onRework !== null
      ) {
        return next;
      }

      current = next;
    }

    return null;
  }

  /**
   * Fire escalation side effects (updateIssueState + postComment).
   * Best-effort: failures are logged, not propagated.
   */
  private async fireEscalationSideEffects(
    issueId: string,
    issueIdentifier: string,
    comment: string,
  ): Promise<void> {
    if (
      this.config.escalationState !== null &&
      this.updateIssueState !== undefined
    ) {
      try {
        await this.updateIssueState(
          issueId,
          issueIdentifier,
          this.config.escalationState,
        );
      } catch (err) {
        console.warn(
          `[orchestrator] Failed to update escalation state for ${issueIdentifier}:`,
          err,
        );
      }
    }
    if (this.postComment !== undefined) {
      try {
        await this.postComment(issueId, comment);
      } catch (err) {
        console.warn(
          `[orchestrator] Failed to post escalation comment for ${issueIdentifier}:`,
          err,
        );
      }
    }
  }

  /**
   * Run ensemble gate: spawn reviewers, aggregate, transition.
   * Called asynchronously from dispatchIssue for ensemble gates.
   */
  private async handleEnsembleGate(
    issue: Issue,
    stage: StageDefinition,
  ): Promise<void> {
    try {
      // biome-ignore lint/style/noNonNullAssertion: runEnsembleGate is guaranteed to be set when this method is called
      const result = await this.runEnsembleGate!({ issue, stage });

      if (result.aggregate === "pass") {
        const nextStage = this.approveGate(issue.id);
        if (nextStage !== null) {
          this.scheduleRetry(issue.id, 1, {
            identifier: issue.identifier,
            error: null,
            delayType: "continuation",
          });
        }
      } else {
        const reworkTarget = this.reworkGate(issue.id);
        if (reworkTarget !== null && reworkTarget !== "escalated") {
          this.scheduleRetry(issue.id, 1, {
            identifier: issue.identifier,
            error: `Ensemble review failed: ${result.comment.slice(0, 200)}`,
            delayType: "continuation",
          });
        } else if (reworkTarget === "escalated") {
          if (
            this.config.escalationState !== null &&
            this.updateIssueState !== undefined
          ) {
            try {
              await this.updateIssueState(
                issue.id,
                issue.identifier,
                this.config.escalationState,
              );
            } catch (err) {
              console.warn(
                `[orchestrator] Failed to update escalation state for ${issue.identifier}:`,
                err,
              );
            }
          }
          if (this.postComment !== undefined) {
            const maxRework =
              stage.type === "gate" ? (stage.maxRework ?? 0) : 0;
            try {
              await this.postComment(
                issue.id,
                `Ensemble review: max rework attempts (${maxRework}) exceeded. Escalating for manual review.`,
              );
            } catch (err) {
              // Comment posting is best-effort — don't fail the gate on it.
              console.warn(
                `[orchestrator] Failed to post escalation comment for ${issue.identifier}:`,
                err,
              );
            }
          }
        }
      }
    } catch {
      // Gate handler failure — release claim so the issue can be retried on next poll.
      this.releaseClaim(issue.id);
    }
  }

  /**
   * Handle gate approval: advance to on_approve target.
   * Returns the next stage name, or null if already terminal/invalid.
   */
  approveGate(issueId: string): string | null {
    const stagesConfig = this.config.stages;
    if (stagesConfig === null) {
      return null;
    }

    const currentStageName = this.state.issueStages[issueId];
    if (currentStageName === undefined) {
      return null;
    }

    const currentStage = stagesConfig.stages[currentStageName];
    if (currentStage === undefined || currentStage.type !== "gate") {
      return null;
    }

    const nextStageName = currentStage.transitions.onApprove;
    if (nextStageName === null) {
      return null;
    }

    this.state.issueStages[issueId] = nextStageName;
    return nextStageName;
  }

  /**
   * Handle gate rework: send issue back to rework target.
   * Tracks rework count and escalates to terminal if max exceeded.
   * Works for both gate-type stages and agent-type stages with onRework set.
   * Returns the rework target stage name, "escalated" if max rework
   * exceeded, or null if no rework transition defined.
   */
  reworkGate(issueId: string): string | "escalated" | null {
    const stagesConfig = this.config.stages;
    if (stagesConfig === null) {
      return null;
    }

    const currentStageName = this.state.issueStages[issueId];
    if (currentStageName === undefined) {
      return null;
    }

    const currentStage = stagesConfig.stages[currentStageName];
    if (currentStage === undefined) {
      return null;
    }

    // Allow gate stages (always) and agent stages with onRework set
    if (
      currentStage.type !== "gate" &&
      !(
        currentStage.type === "agent" &&
        currentStage.transitions.onRework !== null
      )
    ) {
      return null;
    }

    const reworkTarget = currentStage.transitions.onRework;
    if (reworkTarget === null) {
      return null;
    }

    const maxRework = currentStage.maxRework ?? Number.POSITIVE_INFINITY;
    const currentCount = this.state.issueReworkCounts[issueId] ?? 0;

    if (currentCount >= maxRework) {
      // Exceeded max rework — escalate to completed/terminal
      delete this.state.issueStages[issueId];
      delete this.state.issueReworkCounts[issueId];
      delete this.state.issueExecutionHistory[issueId];
      delete this.state.issueFirstDispatchedAt[issueId];
      this.state.completed.add(issueId);
      this.releaseClaim(issueId);
      return "escalated";
    }

    this.state.issueReworkCounts[issueId] = currentCount + 1;
    this.state.issueStages[issueId] = reworkTarget;
    return reworkTarget;
  }

  onCodexEvent(input: {
    issueId: string;
    event: CodexClientEvent;
  }): CodexEventResult {
    const runningEntry = this.state.running[input.issueId];
    if (runningEntry === undefined) {
      return { applied: false };
    }

    applyCodexEventToOrchestratorState(this.state, runningEntry, input.event);
    return { applied: true };
  }

  /**
   * Check if any non-terminal pipeline-halt issues exist.
   * Prefers fetchOpenIssuesByLabels (server-side filtering) when available,
   * falls back to fetchIssuesByLabels with client-side filtering.
   * Returns the first open halt issue, or null if none / on error (fail-open).
   */
  private async checkPipelineHalt(): Promise<Issue | null> {
    if (this.tracker.fetchOpenIssuesByLabels !== undefined) {
      try {
        const haltIssues = await this.tracker.fetchOpenIssuesByLabels(
          ["pipeline-halt"],
          this.config.tracker.terminalStates,
        );
        return haltIssues[0] ?? null;
      } catch (error) {
        console.warn(
          "[orchestrator] fetchOpenIssuesByLabels failed, falling back to fetchIssuesByLabels.",
          error,
        );
      }
    }

    if (this.tracker.fetchIssuesByLabels !== undefined) {
      try {
        const haltIssues = await this.tracker.fetchIssuesByLabels([
          "pipeline-halt",
        ]);
        const terminalStates = toNormalizedStateSet(
          this.config.tracker.terminalStates,
        );
        const openHaltIssue = haltIssues.find((haltIssue) => {
          const normalizedState = normalizeIssueState(haltIssue.state);
          return !terminalStates.has(normalizedState);
        });
        return openHaltIssue ?? null;
      } catch (error) {
        console.warn(
          "[orchestrator] Failed to check for pipeline-halt issues. Continuing dispatch.",
          error,
        );
      }
    }

    return null;
  }

  private syncStateFromConfig(): void {
    this.state.pollIntervalMs = this.config.polling.intervalMs;
    this.state.maxConcurrentAgents = this.config.agent.maxConcurrentAgents;
  }

  private availableSlots(): number {
    return Math.max(
      this.state.maxConcurrentAgents - Object.keys(this.state.running).length,
      0,
    );
  }

  private availableSlotsForState(issueState: string): number {
    const normalizedState = normalizeIssueState(issueState);
    const limit =
      this.config.agent.maxConcurrentAgentsByState[normalizedState] ??
      this.state.maxConcurrentAgents;
    const runningForState = Object.values(this.state.running).filter(
      (entry) => normalizeIssueState(entry.issue.state) === normalizedState,
    ).length;
    return Math.max(limit - runningForState, 0);
  }

  private isRetryCandidateEligible(issue: Issue): boolean {
    if (
      issue.id.trim() === "" ||
      issue.identifier.trim() === "" ||
      issue.title.trim() === "" ||
      issue.state.trim() === ""
    ) {
      return false;
    }

    const normalizedState = normalizeIssueState(issue.state);
    const activeStates = toNormalizedStateSet(this.config.tracker.activeStates);
    const terminalStates = toNormalizedStateSet(
      this.config.tracker.terminalStates,
    );
    if (
      !activeStates.has(normalizedState) ||
      terminalStates.has(normalizedState) ||
      this.state.running[issue.id] !== undefined
    ) {
      return false;
    }

    if (normalizedState !== "todo") {
      return true;
    }

    return issue.blockedBy.every((blocker) => {
      const blockerState =
        blocker.state === null ? null : normalizeIssueState(blocker.state);
      return blockerState !== null && terminalStates.has(blockerState);
    });
  }

  private async dispatchIssue(
    issue: Issue,
    attempt: number | null,
  ): Promise<boolean> {
    const stagesConfig = this.config.stages;
    let stage: StageDefinition | null = null;
    let stageName: string | null = null;

    if (stagesConfig !== null) {
      const cachedStage = this.state.issueStages[issue.id];
      if (cachedStage !== undefined) {
        stageName = cachedStage;
      } else if (
        stagesConfig.fastTrack != null &&
        issue.labels.includes(stagesConfig.fastTrack.label)
      ) {
        stageName = stagesConfig.fastTrack.initialStage;
        console.log(
          `[orchestrator] Fast-tracking ${issue.identifier} to ${stageName} (label: ${stagesConfig.fastTrack.label})`,
        );
      } else {
        stageName = stagesConfig.initialStage;
      }
      stage = stagesConfig.stages[stageName] ?? null;

      if (stage !== null && stage.type === "terminal") {
        this.state.completed.add(issue.id);
        this.releaseClaim(issue.id);
        delete this.state.issueStages[issue.id];
        delete this.state.issueReworkCounts[issue.id];
        delete this.state.issueFirstDispatchedAt[issue.id];
        // Fire linearState update for the terminal stage (e.g., move to "Done")
        if (stage.linearState !== null && this.updateIssueState !== undefined) {
          void this.updateIssueState(
            issue.id,
            issue.identifier,
            stage.linearState,
          ).catch((err) => {
            console.warn(
              `[orchestrator] Failed to update terminal state for ${issue.identifier}:`,
              err,
            );
          });
        }
        return false;
      }

      if (stage !== null && stage.type === "gate") {
        this.state.issueStages[issue.id] = stageName;
        this.state.claimed.add(issue.id);

        if (stage.linearState !== null && this.updateIssueState !== undefined) {
          try {
            await this.updateIssueState(
              issue.id,
              issue.identifier,
              stage.linearState,
            );
          } catch (err) {
            console.warn(
              `[orchestrator] Failed to update issue state for ${issue.identifier}:`,
              err,
            );
          }
        }

        if (
          stage.gateType === "ensemble" &&
          this.runEnsembleGate !== undefined
        ) {
          // Fire ensemble gate asynchronously — resolve transitions on completion.
          void this.handleEnsembleGate(issue, stage);
        }
        // Human gates (or ensemble gates without handler): stay in gate state.
        return false;
      }

      // Track the issue's current stage
      this.state.issueStages[issue.id] = stageName;

      if (
        stage?.linearState !== null &&
        stage?.linearState !== undefined &&
        this.updateIssueState !== undefined
      ) {
        try {
          await this.updateIssueState(
            issue.id,
            issue.identifier,
            stage.linearState,
          );
        } catch (err) {
          console.warn(
            `[orchestrator] Failed to update issue state for ${issue.identifier}:`,
            err,
          );
        }
      }
    }

    if (!this.state.issueFirstDispatchedAt[issue.id]) {
      this.state.issueFirstDispatchedAt[issue.id] = formatEasternTimestamp(
        this.now(),
      );
    }

    try {
      const reworkCount = this.state.issueReworkCounts[issue.id] ?? 0;
      const spawned = await this.spawnWorker({
        issue,
        attempt,
        stage,
        stageName,
        reworkCount,
      });
      this.state.running[issue.id] = {
        ...createEmptyLiveSession(),
        issue,
        identifier: issue.identifier,
        retryAttempt: normalizeRetryAttempt(attempt),
        startedAt: formatEasternTimestamp(this.now()),
        workerHandle: spawned.workerHandle,
        monitorHandle: spawned.monitorHandle,
      };
      this.state.claimed.add(issue.id);
      this.clearRetryEntry(issue.id);
      return true;
    } catch {
      this.scheduleRetry(issue.id, nextRetryAttempt(attempt), {
        identifier: issue.identifier,
        error: "failed to spawn agent",
        delayType: "failure",
      });
      return false;
    }
  }

  private async reconcileRunningIssues(): Promise<{
    stopRequests: StopRequest[];
    reconciliationFetchFailed: boolean;
  }> {
    const stopRequests = await this.reconcileStalledRuns();
    const runningIds = Object.keys(this.state.running);
    if (runningIds.length === 0) {
      return {
        stopRequests,
        reconciliationFetchFailed: false,
      };
    }

    let refreshed: IssueStateSnapshot[];
    try {
      refreshed = await this.tracker.fetchIssueStatesByIds(runningIds);
    } catch {
      return {
        stopRequests,
        reconciliationFetchFailed: true,
      };
    }

    const activeStates = toNormalizedStateSet(this.config.tracker.activeStates);
    const terminalStates = toNormalizedStateSet(
      this.config.tracker.terminalStates,
    );
    const refreshedIds = new Set(refreshed.map((snapshot) => snapshot.id));

    for (const snapshot of refreshed) {
      const runningEntry = this.state.running[snapshot.id];
      if (runningEntry === undefined) {
        continue;
      }

      const normalizedState = normalizeIssueState(snapshot.state);
      if (terminalStates.has(normalizedState)) {
        if (!this.isWorkerInFinalActiveStage(snapshot.id)) {
          stopRequests.push(
            await this.requestStop(runningEntry, true, "terminal_state"),
          );
        }
        continue;
      }

      if (activeStates.has(normalizedState)) {
        runningEntry.issue = {
          ...runningEntry.issue,
          identifier: snapshot.identifier,
          state: snapshot.state,
        };
        runningEntry.identifier = snapshot.identifier;
        continue;
      }

      stopRequests.push(
        await this.requestStop(runningEntry, false, "inactive_state"),
      );
    }

    for (const runningId of runningIds) {
      if (refreshedIds.has(runningId)) {
        continue;
      }

      const runningEntry = this.state.running[runningId];
      if (runningEntry === undefined) {
        continue;
      }

      stopRequests.push(
        await this.requestStop(runningEntry, false, "inactive_state"),
      );
    }

    return {
      stopRequests,
      reconciliationFetchFailed: false,
    };
  }

  /**
   * Returns true if the worker for the given issue is in the final active
   * stage — i.e., its onComplete target is null or points to a terminal stage.
   * In that case, the worker itself drove the issue to terminal state and
   * should be allowed to finish gracefully rather than being stopped.
   */
  private isWorkerInFinalActiveStage(issueId: string): boolean {
    const stagesConfig = this.config.stages;
    if (stagesConfig === null) {
      return false;
    }

    const currentStageName = this.state.issueStages[issueId];
    if (currentStageName === undefined) {
      // Stage already cleaned up by advanceStage (completed) — the worker
      // is finishing its final stage. Allow it to complete gracefully.
      return true;
    }

    const currentStage = stagesConfig.stages[currentStageName];
    if (currentStage === undefined) {
      return false;
    }

    const nextStageName = currentStage.transitions.onComplete;
    if (nextStageName === null) {
      return true;
    }

    const nextStage = stagesConfig.stages[nextStageName];
    if (nextStage === undefined) {
      return false;
    }

    return nextStage.type === "terminal";
  }

  private async reconcileStalledRuns(): Promise<StopRequest[]> {
    if (this.config.codex.stallTimeoutMs <= 0) {
      return [];
    }

    const nowMs = this.now().getTime();
    const stopRequests: StopRequest[] = [];
    for (const runningEntry of Object.values(this.state.running)) {
      const baselineTimestamp = parseEventTimestamp(
        runningEntry.lastCodexTimestamp,
        runningEntry.startedAt,
      );
      if (baselineTimestamp === null) {
        continue;
      }

      if (nowMs - baselineTimestamp > this.config.codex.stallTimeoutMs) {
        stopRequests.push(
          await this.requestStop(runningEntry, false, "stall_timeout"),
        );
      }
    }

    return stopRequests;
  }

  private async requestStop(
    runningEntry: RunningEntry,
    cleanupWorkspace: boolean,
    reason: StopReason,
  ): Promise<StopRequest> {
    const stopRequest: StopRequest = {
      issueId: runningEntry.issue.id,
      issueIdentifier: runningEntry.identifier,
      cleanupWorkspace,
      reason,
    };

    await this.stopRunningIssue?.({
      issueId: runningEntry.issue.id,
      runningEntry,
      cleanupWorkspace,
      reason,
    });

    return stopRequest;
  }

  private scheduleRetry(
    issueId: string,
    attempt: number,
    input: {
      identifier: string | null;
      error: string | null;
      delayType: "continuation" | "failure";
    },
  ): RetryEntry | null {
    // Max retry guard — only applies to failure retries, not continuations
    if (
      input.delayType === "failure" &&
      attempt > this.config.agent.maxRetryAttempts
    ) {
      this.state.completed.add(issueId);
      this.releaseClaim(issueId);
      delete this.state.issueStages[issueId];
      delete this.state.issueReworkCounts[issueId];
      delete this.state.issueExecutionHistory[issueId];
      delete this.state.issueFirstDispatchedAt[issueId];
      void this.fireEscalationSideEffects(
        issueId,
        input.identifier ?? issueId,
        `Max retry attempts (${this.config.agent.maxRetryAttempts}) exceeded. Escalating for manual review.`,
      );
      return null;
    }

    this.clearRetryEntry(issueId);

    const delayMs =
      input.delayType === "continuation"
        ? CONTINUATION_RETRY_DELAY_MS
        : computeFailureRetryDelayMs(
            attempt,
            this.config.agent.maxRetryBackoffMs,
          );
    const dueAtMs = this.now().getTime() + delayMs;
    const timerHandle = this.timerScheduler.set(() => {
      void this.onRetryTimer(issueId);
    }, delayMs);

    const retryEntry: RetryEntry = {
      issueId,
      identifier: input.identifier,
      attempt,
      dueAtMs,
      timerHandle,
      error: input.error,
      delayType: input.delayType,
    };

    this.state.claimed.add(issueId);
    this.state.retryAttempts[issueId] = retryEntry;
    return retryEntry;
  }

  private clearRetryEntry(issueId: string): void {
    const current = this.state.retryAttempts[issueId];
    if (current !== undefined) {
      this.timerScheduler.clear(current.timerHandle);
      delete this.state.retryAttempts[issueId];
    }
  }

  private releaseClaim(issueId: string): void {
    this.clearRetryEntry(issueId);
    this.state.claimed.delete(issueId);
  }
}

export function sortIssuesForDispatch(issues: readonly Issue[]): Issue[] {
  return issues.slice().sort((left, right) => {
    const priorityDelta =
      toSortablePriority(left.priority) - toSortablePriority(right.priority);
    if (priorityDelta !== 0) {
      return priorityDelta;
    }

    const createdAtDelta =
      toSortableDate(left.createdAt) - toSortableDate(right.createdAt);
    if (createdAtDelta !== 0) {
      return createdAtDelta;
    }

    return left.identifier.localeCompare(right.identifier, "en");
  });
}

export function computeFailureRetryDelayMs(
  attempt: number,
  maxRetryBackoffMs: number,
): number {
  const normalizedAttempt = Math.max(attempt, 1);
  const exponentialDelay =
    FAILURE_RETRY_BASE_DELAY_MS * 2 ** (normalizedAttempt - 1);
  return Math.min(exponentialDelay, maxRetryBackoffMs);
}

export function nextRetryAttempt(attempt: number | null): number {
  return attempt === null ? 1 : attempt + 1;
}

function normalizeRetryAttempt(attempt: number | null): number | null {
  return attempt === null ? null : Math.max(1, Math.floor(attempt));
}

function formatWorkerExitReason(reason: string | undefined): string {
  const normalized = reason?.trim();
  return normalized && normalized.length > 0
    ? `worker exited: ${normalized}`
    : "worker exited: abnormal";
}

function toSortablePriority(priority: number | null): number {
  return priority === null ? Number.POSITIVE_INFINITY : priority;
}

function toSortableDate(timestamp: string | null): number {
  if (timestamp === null) {
    return Number.POSITIVE_INFINITY;
  }

  const parsed = Date.parse(timestamp);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function parseEventTimestamp(
  lastCodexTimestamp: string | null,
  startedAt: string,
): number | null {
  if (lastCodexTimestamp !== null) {
    const parsed = Date.parse(lastCodexTimestamp);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  const startedAtMs = Date.parse(startedAt);
  return Number.isFinite(startedAtMs) ? startedAtMs : null;
}

function toNormalizedStateSet(states: readonly string[]): Set<string> {
  return new Set(states.map((state) => normalizeIssueState(state)));
}

function defaultTimerScheduler(): TimerScheduler {
  return {
    set(callback, delayMs) {
      return setTimeout(callback, delayMs);
    },
    clear(handle) {
      if (handle !== null) {
        clearTimeout(handle);
      }
    },
  };
}
