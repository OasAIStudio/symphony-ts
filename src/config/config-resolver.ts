import { homedir } from "node:os";
import { isAbsolute, normalize, resolve, sep } from "node:path";

import type { WorkflowDefinition } from "../domain/model.js";
import { normalizeIssueState } from "../domain/model.js";
import { ERROR_CODES } from "../errors/codes.js";
import {
  DEFAULT_ACTIVE_STATES,
  DEFAULT_CODEX_COMMAND,
  DEFAULT_HOOK_TIMEOUT_MS,
  DEFAULT_LINEAR_ENDPOINT,
  DEFAULT_LINEAR_NETWORK_TIMEOUT_MS,
  DEFAULT_LINEAR_PAGE_SIZE,
  DEFAULT_MAX_CONCURRENT_AGENTS,
  DEFAULT_MAX_CONCURRENT_AGENTS_BY_STATE,
  DEFAULT_MAX_RETRY_ATTEMPTS,
  DEFAULT_MAX_RETRY_BACKOFF_MS,
  DEFAULT_MAX_TURNS,
  DEFAULT_OBSERVABILITY_ENABLED,
  DEFAULT_OBSERVABILITY_REFRESH_MS,
  DEFAULT_OBSERVABILITY_RENDER_INTERVAL_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_READ_TIMEOUT_MS,
  DEFAULT_RUNNER_KIND,
  DEFAULT_STALL_TIMEOUT_MS,
  DEFAULT_TERMINAL_STATES,
  DEFAULT_TRACKER_KIND,
  DEFAULT_TURN_TIMEOUT_MS,
  DEFAULT_WORKSPACE_ROOT,
} from "./defaults.js";
import type {
  DispatchValidationResult,
  FastTrackConfig,
  GateType,
  ResolvedWorkflowConfig,
  ReviewerDefinition,
  StageDefinition,
  StageTransitions,
  StageType,
  StagesConfig,
} from "./types.js";
import { GATE_TYPES, STAGE_TYPES } from "./types.js";

const LINEAR_CANONICAL_API_KEY_ENV = "LINEAR_API_KEY";

export function resolveWorkflowConfig(
  workflow: WorkflowDefinition & { workflowPath: string },
  environment: NodeJS.ProcessEnv = process.env,
): ResolvedWorkflowConfig {
  const config = workflow.config;
  const tracker = asRecord(config.tracker);
  const polling = asRecord(config.polling);
  const workspace = asRecord(config.workspace);
  const hooks = asRecord(config.hooks);
  const agent = asRecord(config.agent);
  const runner = asRecord(config.runner);
  const codex = asRecord(config.codex);
  const server = asRecord(config.server);
  const observability = asRecord(config.observability);

  return {
    workflowPath: workflow.workflowPath,
    promptTemplate: workflow.promptTemplate,
    tracker: {
      kind: readString(tracker.kind) ?? DEFAULT_TRACKER_KIND,
      endpoint: readString(tracker.endpoint) ?? DEFAULT_LINEAR_ENDPOINT,
      apiKey:
        resolveEnvReference(readString(tracker.api_key), environment) ??
        environment[LINEAR_CANONICAL_API_KEY_ENV] ??
        null,
      projectSlug: readString(tracker.project_slug),
      activeStates: readStringList(
        tracker.active_states,
        DEFAULT_ACTIVE_STATES,
      ),
      terminalStates: readStringList(
        tracker.terminal_states,
        DEFAULT_TERMINAL_STATES,
      ),
    },
    polling: {
      intervalMs: readInteger(polling.interval_ms) ?? DEFAULT_POLL_INTERVAL_MS,
    },
    workspace: {
      root:
        resolvePathValue(
          readString(workspace.root),
          workflow.workflowPath,
          environment,
        ) ?? DEFAULT_WORKSPACE_ROOT,
    },
    hooks: {
      afterCreate: readScript(hooks.after_create),
      beforeRun: readScript(hooks.before_run),
      afterRun: readScript(hooks.after_run),
      beforeRemove: readScript(hooks.before_remove),
      timeoutMs:
        readPositiveInteger(hooks.timeout_ms) ?? DEFAULT_HOOK_TIMEOUT_MS,
    },
    agent: {
      maxConcurrentAgents:
        readPositiveInteger(agent.max_concurrent_agents) ??
        DEFAULT_MAX_CONCURRENT_AGENTS,
      maxTurns: readPositiveInteger(agent.max_turns) ?? DEFAULT_MAX_TURNS,
      maxRetryBackoffMs:
        readPositiveInteger(agent.max_retry_backoff_ms) ??
        DEFAULT_MAX_RETRY_BACKOFF_MS,
      maxRetryAttempts:
        readPositiveInteger(agent.max_retry_attempts) ??
        DEFAULT_MAX_RETRY_ATTEMPTS,
      maxConcurrentAgentsByState: readStateConcurrencyMap(
        agent.max_concurrent_agents_by_state,
      ),
    },
    runner: {
      kind: readString(runner.kind) ?? DEFAULT_RUNNER_KIND,
      model: readString(runner.model),
    },
    codex: {
      command: readString(codex.command) ?? DEFAULT_CODEX_COMMAND,
      approvalPolicy: codex.approval_policy,
      threadSandbox: codex.thread_sandbox,
      turnSandboxPolicy: codex.turn_sandbox_policy,
      turnTimeoutMs:
        readPositiveInteger(codex.turn_timeout_ms) ?? DEFAULT_TURN_TIMEOUT_MS,
      readTimeoutMs:
        readPositiveInteger(codex.read_timeout_ms) ?? DEFAULT_READ_TIMEOUT_MS,
      stallTimeoutMs:
        readInteger(codex.stall_timeout_ms) ?? DEFAULT_STALL_TIMEOUT_MS,
    },
    server: {
      port: readNonNegativeInteger(server.port),
      slackNotifyChannel:
        readString(server.slack_notify_channel) ??
        environment.SLACK_NOTIFY_CHANNEL ??
        null,
    },
    observability: {
      dashboardEnabled:
        readBoolean(observability.dashboard_enabled) ??
        DEFAULT_OBSERVABILITY_ENABLED,
      refreshMs:
        readPositiveInteger(observability.refresh_ms) ??
        DEFAULT_OBSERVABILITY_REFRESH_MS,
      renderIntervalMs:
        readPositiveInteger(observability.render_interval_ms) ??
        DEFAULT_OBSERVABILITY_RENDER_INTERVAL_MS,
    },
    stages: resolveStagesConfig(config.stages),
    escalationState: readString(config.escalation_state),
  };
}

export function validateDispatchConfig(
  config: ResolvedWorkflowConfig,
): DispatchValidationResult {
  const trackerKind = config.tracker.kind?.trim();
  if (!trackerKind) {
    return invalid(
      ERROR_CODES.configInvalid,
      "tracker.kind must be present before dispatch.",
    );
  }

  if (trackerKind !== DEFAULT_TRACKER_KIND) {
    return invalid(
      ERROR_CODES.unsupportedTrackerKind,
      `tracker.kind '${trackerKind}' is not supported.`,
    );
  }

  if (!config.tracker.apiKey || config.tracker.apiKey.trim() === "") {
    return invalid(
      ERROR_CODES.trackerCredentialsMissing,
      "tracker.api_key must be configured before dispatch.",
    );
  }

  if (!config.tracker.projectSlug || config.tracker.projectSlug.trim() === "") {
    return invalid(
      ERROR_CODES.configInvalid,
      "tracker.project_slug must be configured before dispatch.",
    );
  }

  if (config.codex.command.trim() === "") {
    return invalid(
      ERROR_CODES.configInvalid,
      "codex.command must be present and non-empty before dispatch.",
    );
  }

  return { ok: true };
}

function invalid(code: string, message: string): DispatchValidationResult {
  return {
    ok: false,
    error: {
      code,
      message,
    },
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Record<string, unknown>;
}

function readString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  return value;
}

function readScript(value: unknown): string | null {
  const script = readString(value);
  if (script === null) {
    return null;
  }

  return script === "" ? null : script;
}

function readInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }

  if (typeof value === "string" && /^-?\d+$/.test(value.trim())) {
    return Number.parseInt(value.trim(), 10);
  }

  return null;
}

function readBoolean(value: unknown): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }

  return null;
}

function readPositiveInteger(value: unknown): number | null {
  const parsed = readInteger(value);
  if (parsed === null || parsed <= 0) {
    return null;
  }

  return parsed;
}

function readNonNegativeInteger(value: unknown): number | null {
  const parsed = readInteger(value);
  if (parsed === null || parsed < 0) {
    return null;
  }

  return parsed;
}

function readStringList(value: unknown, fallback: readonly string[]): string[] {
  if (Array.isArray(value)) {
    const items = value.filter(
      (entry): entry is string => typeof entry === "string",
    );
    if (items.length > 0) {
      return items.map((entry) => entry.trim()).filter((entry) => entry !== "");
    }
  }

  if (typeof value === "string") {
    const items = value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
    if (items.length > 0) {
      return items;
    }
  }

  return [...fallback];
}

function readStateConcurrencyMap(
  value: unknown,
): Readonly<Record<string, number>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return DEFAULT_MAX_CONCURRENT_AGENTS_BY_STATE;
  }

  const normalizedEntries = Object.entries(value).flatMap(([state, limit]) => {
    const parsedLimit = readPositiveInteger(limit);
    if (parsedLimit === null) {
      return [];
    }

    return [[normalizeIssueState(state), parsedLimit] as const];
  });

  return Object.freeze(Object.fromEntries(normalizedEntries));
}

function resolveEnvReference(
  value: string | null,
  environment: NodeJS.ProcessEnv,
): string | null {
  if (!value) {
    return null;
  }

  if (!value.startsWith("$")) {
    return value;
  }

  const envName = value.slice(1);
  const resolvedValue = environment[envName];
  if (!resolvedValue || resolvedValue.trim() === "") {
    return null;
  }

  return resolvedValue;
}

function resolvePathValue(
  value: string | null,
  workflowPath: string,
  environment: NodeJS.ProcessEnv,
): string | null {
  const rawPath = resolveEnvReference(value, environment);
  if (!rawPath) {
    return null;
  }

  let expanded = rawPath.startsWith("~")
    ? `${homedir()}${rawPath.slice(1)}`
    : rawPath;

  if (
    !expanded.includes(sep) &&
    !expanded.includes("/") &&
    !expanded.includes("\\")
  ) {
    return expanded;
  }

  if (isAbsolute(expanded)) {
    return normalize(expanded);
  }

  expanded = resolve(resolve(workflowPath, ".."), expanded);
  return normalize(expanded);
}

export function resolveStagesConfig(value: unknown): StagesConfig | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const raw = value as Record<string, unknown>;
  const stageEntries: Record<string, StageDefinition> = {};
  let firstStageName: string | null = null;

  for (const [name, stageValue] of Object.entries(raw)) {
    if (name === "initial_stage" || name === "fast_track") {
      continue;
    }

    const stageRecord = asRecord(stageValue);
    const rawType = readString(stageRecord.type);
    const stageType = parseStageType(rawType);
    if (stageType === null) {
      continue;
    }

    if (firstStageName === null) {
      firstStageName = name;
    }

    stageEntries[name] = {
      type: stageType,
      runner: readString(stageRecord.runner),
      model: readString(stageRecord.model),
      prompt: readString(stageRecord.prompt),
      maxTurns: readPositiveInteger(stageRecord.max_turns),
      timeoutMs: readPositiveInteger(stageRecord.timeout_ms),
      concurrency: readPositiveInteger(stageRecord.concurrency),
      gateType: parseGateType(readString(stageRecord.gate_type)),
      maxRework: readPositiveInteger(stageRecord.max_rework),
      reviewers: parseReviewers(stageRecord.reviewers),
      transitions: {
        onComplete: readString(stageRecord.on_complete),
        onApprove: readString(stageRecord.on_approve),
        onRework: readString(stageRecord.on_rework),
      },
      linearState: readString(stageRecord.linear_state),
    };
  }

  if (Object.keys(stageEntries).length === 0) {
    return null;
  }

  // biome-ignore lint/style/noNonNullAssertion: firstStageName guaranteed non-null when stageEntries is non-empty
  const initialStage = readString(raw.initial_stage) ?? firstStageName!;

  const fastTrackRaw = asRecord(raw.fast_track);
  const fastTrackLabel = readString(fastTrackRaw.label);
  const fastTrackInitialStage = readString(fastTrackRaw.initial_stage);
  const fastTrack: FastTrackConfig | null =
    fastTrackLabel !== null && fastTrackInitialStage !== null
      ? { label: fastTrackLabel, initialStage: fastTrackInitialStage }
      : null;

  return Object.freeze({
    initialStage,
    fastTrack,
    stages: Object.freeze(stageEntries),
  });
}

export interface StagesValidationResult {
  ok: boolean;
  errors: string[];
}

export function validateStagesConfig(
  stagesConfig: StagesConfig | null,
): StagesValidationResult {
  if (stagesConfig === null) {
    return { ok: true, errors: [] };
  }

  const errors: string[] = [];
  const stageNames = new Set(Object.keys(stagesConfig.stages));

  if (!stageNames.has(stagesConfig.initialStage)) {
    errors.push(
      `initial_stage '${stagesConfig.initialStage}' does not reference a defined stage.`,
    );
  }

  if (
    stagesConfig.fastTrack != null &&
    !stageNames.has(stagesConfig.fastTrack.initialStage)
  ) {
    errors.push(
      `fast_track.initial_stage '${stagesConfig.fastTrack.initialStage}' does not reference a defined stage.`,
    );
  }

  let hasTerminal = false;
  for (const [name, stage] of Object.entries(stagesConfig.stages)) {
    if (stage.type === "terminal") {
      hasTerminal = true;
      continue;
    }

    if (stage.type === "agent") {
      if (stage.transitions.onComplete === null) {
        errors.push(`Stage '${name}' (agent) has no on_complete transition.`);
      } else if (!stageNames.has(stage.transitions.onComplete)) {
        errors.push(
          `Stage '${name}' on_complete references unknown stage '${stage.transitions.onComplete}'.`,
        );
      }

      if (
        stage.transitions.onRework !== null &&
        !stageNames.has(stage.transitions.onRework)
      ) {
        errors.push(
          `Stage '${name}' on_rework references unknown stage '${stage.transitions.onRework}'.`,
        );
      }
    }

    if (stage.type === "gate") {
      if (stage.transitions.onApprove === null) {
        errors.push(`Stage '${name}' (gate) has no on_approve transition.`);
      } else if (!stageNames.has(stage.transitions.onApprove)) {
        errors.push(
          `Stage '${name}' on_approve references unknown stage '${stage.transitions.onApprove}'.`,
        );
      }

      if (
        stage.transitions.onRework !== null &&
        !stageNames.has(stage.transitions.onRework)
      ) {
        errors.push(
          `Stage '${name}' on_rework references unknown stage '${stage.transitions.onRework}'.`,
        );
      }
    }
  }

  if (!hasTerminal) {
    errors.push(
      "No terminal stage defined. At least one stage must have type 'terminal'.",
    );
  }

  // Check reachability from initial stage
  const reachable = new Set<string>();
  const queue = [stagesConfig.initialStage];
  while (queue.length > 0) {
    // biome-ignore lint/style/noNonNullAssertion: queue.length > 0 guarantees pop() returns a value
    const current = queue.pop()!;
    if (reachable.has(current)) {
      continue;
    }
    reachable.add(current);

    const stage = stagesConfig.stages[current];
    if (stage === undefined) {
      continue;
    }

    for (const target of [
      stage.transitions.onComplete,
      stage.transitions.onApprove,
      stage.transitions.onRework,
    ]) {
      if (target !== null && !reachable.has(target)) {
        queue.push(target);
      }
    }
  }

  for (const name of stageNames) {
    if (!reachable.has(name)) {
      errors.push(
        `Stage '${name}' is unreachable from initial stage '${stagesConfig.initialStage}'.`,
      );
    }
  }

  return { ok: errors.length === 0, errors };
}

function parseReviewers(value: unknown): ReviewerDefinition[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.flatMap((entry) => {
    const record = asRecord(entry);
    const runner = readString(record.runner);
    const role = readString(record.role);
    if (runner === null || role === null) {
      return [];
    }

    return [
      {
        runner,
        model: readString(record.model),
        role,
        prompt: readString(record.prompt),
      },
    ];
  });
}

function parseStageType(value: string | null): StageType | null {
  if (value === null) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return (STAGE_TYPES as readonly string[]).includes(normalized)
    ? (normalized as StageType)
    : null;
}

function parseGateType(value: string | null): GateType | null {
  if (value === null) {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  return (GATE_TYPES as readonly string[]).includes(normalized)
    ? (normalized as GateType)
    : null;
}

export const LINEAR_DEFAULTS = Object.freeze({
  endpoint: DEFAULT_LINEAR_ENDPOINT,
  pageSize: DEFAULT_LINEAR_PAGE_SIZE,
  networkTimeoutMs: DEFAULT_LINEAR_NETWORK_TIMEOUT_MS,
});
