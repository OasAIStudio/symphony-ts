export interface WorkflowHooksConfig {
  afterCreate: string | null;
  beforeRun: string | null;
  afterRun: string | null;
  beforeRemove: string | null;
  timeoutMs: number;
}

export interface WorkflowTrackerConfig {
  kind: string | null;
  endpoint: string;
  apiKey: string | null;
  projectSlug: string | null;
  activeStates: string[];
  terminalStates: string[];
}

export interface WorkflowPollingConfig {
  intervalMs: number;
}

export interface WorkflowWorkspaceConfig {
  root: string;
}

export interface WorkflowAgentConfig {
  maxConcurrentAgents: number;
  maxTurns: number;
  maxRetryBackoffMs: number;
  maxRetryAttempts: number;
  maxConcurrentAgentsByState: Readonly<Record<string, number>>;
}

export interface WorkflowRunnerConfig {
  kind: string;
  model: string | null;
}

export interface WorkflowCodexConfig {
  command: string;
  approvalPolicy: unknown;
  threadSandbox: unknown;
  turnSandboxPolicy: unknown;
  turnTimeoutMs: number;
  readTimeoutMs: number;
  stallTimeoutMs: number;
}

export interface WorkflowServerConfig {
  port: number | null;
  slackNotifyChannel: string | null;
}

export interface WorkflowObservabilityConfig {
  dashboardEnabled: boolean;
  refreshMs: number;
  renderIntervalMs: number;
}

export const STAGE_TYPES = ["agent", "gate", "terminal"] as const;
export type StageType = (typeof STAGE_TYPES)[number];

export const GATE_TYPES = ["ensemble", "human"] as const;
export type GateType = (typeof GATE_TYPES)[number];

export interface StageTransitions {
  onComplete: string | null;
  onApprove: string | null;
  onRework: string | null;
}

export interface ReviewerDefinition {
  runner: string;
  model: string | null;
  role: string;
  prompt: string | null;
}

export interface StageDefinition {
  type: StageType;
  runner: string | null;
  model: string | null;
  prompt: string | null;
  maxTurns: number | null;
  timeoutMs: number | null;
  concurrency: number | null;
  gateType: GateType | null;
  maxRework: number | null;
  reviewers: ReviewerDefinition[];
  transitions: StageTransitions;
  linearState: string | null;
}

export interface FastTrackConfig {
  label: string;
  initialStage: string;
}

export interface StagesConfig {
  initialStage: string;
  fastTrack: FastTrackConfig | null;
  stages: Readonly<Record<string, StageDefinition>>;
}

export interface ResolvedWorkflowConfig {
  workflowPath: string;
  promptTemplate: string;
  tracker: WorkflowTrackerConfig;
  polling: WorkflowPollingConfig;
  workspace: WorkflowWorkspaceConfig;
  hooks: WorkflowHooksConfig;
  agent: WorkflowAgentConfig;
  runner: WorkflowRunnerConfig;
  codex: WorkflowCodexConfig;
  server: WorkflowServerConfig;
  observability: WorkflowObservabilityConfig;
  stages: StagesConfig | null;
  escalationState: string | null;
}

export interface DispatchValidationFailure {
  code: string;
  message: string;
}

export type DispatchValidationResult =
  | {
      ok: true;
    }
  | {
      ok: false;
      error: DispatchValidationFailure;
    };

export interface WorkflowSnapshot {
  definition: {
    workflowPath: string;
    config: Record<string, unknown>;
    promptTemplate: string;
  };
  config: ResolvedWorkflowConfig;
  dispatchValidation: DispatchValidationResult;
  loadedAt: string;
}

export type WorkflowReloadReason = "manual" | "filesystem_event";

export type WorkflowReloadResult =
  | {
      ok: true;
      reason: WorkflowReloadReason;
      previousSnapshot: WorkflowSnapshot;
      snapshot: WorkflowSnapshot;
    }
  | {
      ok: false;
      reason: WorkflowReloadReason;
      currentSnapshot: WorkflowSnapshot;
      error: unknown;
    };
