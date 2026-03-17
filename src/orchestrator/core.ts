import type { CodexClientEvent } from "../codex/app-server-client.js";
import { validateDispatchConfig } from "../config/config-resolver.js";
import type {
  DispatchValidationResult,
  ResolvedWorkflowConfig,
  StageDefinition,
} from "../config/types.js";
import {
  type Issue,
  type OrchestratorState,
  type RetryEntry,
  type RunningEntry,
  createEmptyLiveSession,
  createInitialOrchestratorState,
  normalizeIssueState,
} from "../domain/model.js";
import {
  addEndedSessionRuntime,
  applyCodexEventToOrchestratorState,
} from "../logging/session-metrics.js";
import type { EnsembleGateResult } from "./gate-handler.js";
import type { IssueStateSnapshot, IssueTracker } from "../tracker/tracker.js";

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
  timerScheduler?: TimerScheduler;
  now?: () => Date;
}

export class OrchestratorCore {
  private config: ResolvedWorkflowConfig;

  private tracker: IssueTracker;

  private readonly spawnWorker: OrchestratorCoreOptions["spawnWorker"];

  private readonly stopRunningIssue?: OrchestratorCoreOptions["stopRunningIssue"];

  private readonly runEnsembleGate?: OrchestratorCoreOptions["runEnsembleGate"];

  private readonly timerScheduler: TimerScheduler;

  private readonly now: () => Date;

  private readonly state: OrchestratorState;

  constructor(options: OrchestratorCoreOptions) {
    this.config = options.config;
    this.tracker = options.tracker;
    this.spawnWorker = options.spawnWorker;
    this.stopRunningIssue = options.stopRunningIssue;
    this.runEnsembleGate = options.runEnsembleGate;
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

    if (normalizedState !== "todo") {
      return true;
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
          delayType: "failure",
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
          delayType: "failure",
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
  }): RetryEntry | null {
    const runningEntry = this.state.running[input.issueId];
    if (runningEntry === undefined) {
      return null;
    }

    delete this.state.running[input.issueId];
    addEndedSessionRuntime(
      this.state,
      runningEntry.startedAt,
      input.endedAt ?? this.now(),
    );

    if (input.outcome === "normal") {
      const transition = this.advanceStage(input.issueId);
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
   */
  private advanceStage(
    issueId: string,
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
      return "completed";
    }

    const nextStage = stagesConfig.stages[nextStageName];
    if (nextStage === undefined) {
      // Invalid target — treat as terminal
      delete this.state.issueStages[issueId];
      delete this.state.issueReworkCounts[issueId];
      return "completed";
    }

    if (nextStage.type === "terminal") {
      delete this.state.issueStages[issueId];
      delete this.state.issueReworkCounts[issueId];
      return "completed";
    }

    // Move to the next stage
    this.state.issueStages[issueId] = nextStageName;
    return "advanced";
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
    if (currentStage === undefined || currentStage.type !== "gate") {
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
      stageName =
        this.state.issueStages[issue.id] ?? stagesConfig.initialStage;
      stage = stagesConfig.stages[stageName] ?? null;

      if (stage !== null && stage.type === "terminal") {
        this.state.completed.add(issue.id);
        this.releaseClaim(issue.id);
        delete this.state.issueStages[issue.id];
        delete this.state.issueReworkCounts[issue.id];
        return false;
      }

      if (stage !== null && stage.type === "gate") {
        this.state.issueStages[issue.id] = stageName;
        this.state.claimed.add(issue.id);

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
    }

    try {
      const spawned = await this.spawnWorker({ issue, attempt, stage, stageName });
      this.state.running[issue.id] = {
        ...createEmptyLiveSession(),
        issue,
        identifier: issue.identifier,
        retryAttempt: normalizeRetryAttempt(attempt),
        startedAt: this.now().toISOString(),
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
        stopRequests.push(
          await this.requestStop(runningEntry, true, "terminal_state"),
        );
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
  ): RetryEntry {
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
