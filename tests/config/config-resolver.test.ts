import { homedir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  resolveStagesConfig,
  resolveWorkflowConfig,
  validateDispatchConfig,
  validateStagesConfig,
} from "../../src/config/config-resolver.js";
import {
  DEFAULT_CODEX_COMMAND,
  DEFAULT_HOOK_TIMEOUT_MS,
  DEFAULT_MAX_CONCURRENT_AGENTS,
  DEFAULT_MAX_RETRY_BACKOFF_MS,
  DEFAULT_MAX_TURNS,
  DEFAULT_OBSERVABILITY_ENABLED,
  DEFAULT_OBSERVABILITY_REFRESH_MS,
  DEFAULT_OBSERVABILITY_RENDER_INTERVAL_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_READ_TIMEOUT_MS,
  DEFAULT_STALL_TIMEOUT_MS,
  DEFAULT_TURN_TIMEOUT_MS,
  DEFAULT_WORKSPACE_ROOT,
} from "../../src/config/defaults.js";
import { ERROR_CODES } from "../../src/errors/codes.js";

describe("config-resolver", () => {
  it("applies spec defaults when workflow config is empty", () => {
    const resolved = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      config: {},
      promptTemplate: "Prompt",
    });

    expect(resolved.tracker.kind).toBe("linear");
    expect(resolved.tracker.endpoint).toBe("https://api.linear.app/graphql");
    expect(resolved.tracker.activeStates).toEqual(["Todo", "In Progress"]);
    expect(resolved.tracker.terminalStates).toEqual([
      "Closed",
      "Cancelled",
      "Canceled",
      "Duplicate",
      "Done",
    ]);
    expect(resolved.polling.intervalMs).toBe(DEFAULT_POLL_INTERVAL_MS);
    expect(resolved.workspace.root).toBe(DEFAULT_WORKSPACE_ROOT);
    expect(resolved.hooks.timeoutMs).toBe(DEFAULT_HOOK_TIMEOUT_MS);
    expect(resolved.agent.maxConcurrentAgents).toBe(
      DEFAULT_MAX_CONCURRENT_AGENTS,
    );
    expect(resolved.agent.maxTurns).toBe(DEFAULT_MAX_TURNS);
    expect(resolved.agent.maxRetryBackoffMs).toBe(DEFAULT_MAX_RETRY_BACKOFF_MS);
    expect(resolved.codex.command).toBe(DEFAULT_CODEX_COMMAND);
    expect(resolved.codex.turnTimeoutMs).toBe(DEFAULT_TURN_TIMEOUT_MS);
    expect(resolved.codex.readTimeoutMs).toBe(DEFAULT_READ_TIMEOUT_MS);
    expect(resolved.codex.stallTimeoutMs).toBe(DEFAULT_STALL_TIMEOUT_MS);
    expect(resolved.observability.dashboardEnabled).toBe(
      DEFAULT_OBSERVABILITY_ENABLED,
    );
    expect(resolved.observability.refreshMs).toBe(
      DEFAULT_OBSERVABILITY_REFRESH_MS,
    );
    expect(resolved.observability.renderIntervalMs).toBe(
      DEFAULT_OBSERVABILITY_RENDER_INTERVAL_MS,
    );
  });

  it("coerces env-backed fields, path-like roots, and state limits", () => {
    const resolved = resolveWorkflowConfig(
      {
        workflowPath: "/repo/WORKFLOW.md",
        promptTemplate: "Prompt",
        config: {
          tracker: {
            api_key: "$LINEAR_TOKEN",
            project_slug: "ENG",
            active_states: "Todo, In Progress, Ready for QA",
          },
          polling: {
            interval_ms: "15000",
          },
          workspace: {
            root: "./tmp/workspaces",
          },
          hooks: {
            timeout_ms: "0",
            before_run: "pnpm test",
          },
          agent: {
            max_concurrent_agents: "4",
            max_turns: "8",
            max_retry_backoff_ms: "120000",
            max_concurrent_agents_by_state: {
              " In Progress ": "2",
              Done: 0,
            },
          },
          codex: {
            command: "codex app-server --stdio",
            turn_timeout_ms: "90000",
            read_timeout_ms: "2500",
            stall_timeout_ms: "-1",
          },
          server: {
            port: "8080",
          },
          observability: {
            dashboard_enabled: "false",
            refresh_ms: "2500",
            render_interval_ms: "33",
          },
        },
      },
      {
        LINEAR_TOKEN: "secret-token",
      },
    );

    expect(resolved.tracker.apiKey).toBe("secret-token");
    expect(resolved.tracker.projectSlug).toBe("ENG");
    expect(resolved.tracker.activeStates).toEqual([
      "Todo",
      "In Progress",
      "Ready for QA",
    ]);
    expect(resolved.polling.intervalMs).toBe(15_000);
    expect(resolved.workspace.root).toBe(join("/repo", "tmp/workspaces"));
    expect(resolved.hooks.beforeRun).toBe("pnpm test");
    expect(resolved.hooks.timeoutMs).toBe(DEFAULT_HOOK_TIMEOUT_MS);
    expect(resolved.agent.maxConcurrentAgents).toBe(4);
    expect(resolved.agent.maxTurns).toBe(8);
    expect(resolved.agent.maxRetryBackoffMs).toBe(120_000);
    expect(resolved.agent.maxConcurrentAgentsByState).toEqual({
      "in progress": 2,
    });
    expect(resolved.codex.command).toBe("codex app-server --stdio");
    expect(resolved.codex.turnTimeoutMs).toBe(90_000);
    expect(resolved.codex.readTimeoutMs).toBe(2_500);
    expect(resolved.codex.stallTimeoutMs).toBe(-1);
    expect(resolved.server.port).toBe(8080);
    expect(resolved.observability.dashboardEnabled).toBe(false);
    expect(resolved.observability.refreshMs).toBe(2_500);
    expect(resolved.observability.renderIntervalMs).toBe(33);
  });

  it("accepts server.port zero for ephemeral listener binding", () => {
    const resolved = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {
        server: {
          port: 0,
        },
      },
    });

    expect(resolved.server.port).toBe(0);
  });

  it("ignores invalid negative or non-integer server.port values", () => {
    const negative = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {
        server: {
          port: -1,
        },
      },
    });
    const invalidString = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {
        server: {
          port: "eight-thousand",
        },
      },
    });

    expect(negative.server.port).toBeNull();
    expect(invalidString.server.port).toBeNull();
  });

  it("uses the canonical LINEAR_API_KEY env var fallback", () => {
    const resolved = resolveWorkflowConfig(
      {
        workflowPath: "/repo/WORKFLOW.md",
        promptTemplate: "Prompt",
        config: {
          tracker: {
            project_slug: "ENG",
          },
        },
      },
      {
        LINEAR_API_KEY: "canonical-secret",
      },
    );

    expect(resolved.tracker.apiKey).toBe("canonical-secret");
  });

  it("resolves env-backed workspace roots and expands the home directory", () => {
    const envBacked = resolveWorkflowConfig(
      {
        workflowPath: "/repo/WORKFLOW.md",
        promptTemplate: "Prompt",
        config: {
          workspace: {
            root: "$WORKSPACE_ROOT",
          },
        },
      },
      {
        WORKSPACE_ROOT: "~/symphony-workspaces",
      },
    );

    expect(envBacked.workspace.root).toBe(
      join(homedir(), "symphony-workspaces"),
    );
  });

  it("parses escalation_state from top-level config", () => {
    const resolved = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {
        escalation_state: "Needs Triage",
      },
    });

    expect(resolved.escalationState).toBe("Needs Triage");
  });

  it("defaults escalationState to null when not specified", () => {
    const resolved = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {},
    });

    expect(resolved.escalationState).toBeNull();
  });

  it("blocks dispatch when required tracker settings are missing", () => {
    const resolved = resolveWorkflowConfig(
      {
        workflowPath: "/repo/WORKFLOW.md",
        promptTemplate: "Prompt",
        config: {},
      },
      {},
    );

    const validation = validateDispatchConfig(resolved);
    expect(validation).toEqual({
      ok: false,
      error: {
        code: ERROR_CODES.trackerCredentialsMissing,
        message: "tracker.api_key must be configured before dispatch.",
      },
    });
  });

  it("rejects unsupported tracker kinds during dispatch validation", () => {
    const validation = validateDispatchConfig(
      resolveWorkflowConfig(
        {
          workflowPath: "/repo/WORKFLOW.md",
          promptTemplate: "Prompt",
          config: {
            tracker: {
              kind: "jira",
              api_key: "token",
              project_slug: "ENG",
            },
          },
        },
        {},
      ),
    );

    expect(validation).toEqual({
      ok: false,
      error: {
        code: ERROR_CODES.unsupportedTrackerKind,
        message: "tracker.kind 'jira' is not supported.",
      },
    });
  });

  it("accepts dispatch when tracker and codex prerequisites are present", () => {
    const validation = validateDispatchConfig(
      resolveWorkflowConfig(
        {
          workflowPath: "/repo/WORKFLOW.md",
          promptTemplate: "Prompt",
          config: {
            tracker: {
              kind: "linear",
              api_key: "token",
              project_slug: "ENG",
            },
          },
        },
        {},
      ),
    );

    expect(validation).toEqual({ ok: true });
  });
});

describe("config-resolver fast_track", () => {
  it("parses fast_track label and initial_stage from stages config", () => {
    const resolved = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {
        stages: {
          initial_stage: "investigate",
          fast_track: {
            label: "trivial",
            initial_stage: "implement",
          },
          investigate: { type: "agent", on_complete: "implement" },
          implement: { type: "agent", on_complete: "done" },
          done: { type: "terminal" },
        },
      },
    });

    expect(resolved.stages).not.toBeNull();
    expect(resolved.stages?.fastTrack).toEqual({
      label: "trivial",
      initialStage: "implement",
    });
  });

  it("sets fastTrack to null when fast_track is not present in stages config", () => {
    const resolved = resolveWorkflowConfig({
      workflowPath: "/repo/WORKFLOW.md",
      promptTemplate: "Prompt",
      config: {
        stages: {
          initial_stage: "investigate",
          investigate: { type: "agent", on_complete: "done" },
          done: { type: "terminal" },
        },
      },
    });

    expect(resolved.stages?.fastTrack).toBeNull();
  });

  it("fast_track validation rejects unknown fast_track initial_stage target", () => {
    const stagesConfig = resolveStagesConfig({
      initial_stage: "investigate",
      fast_track: {
        label: "trivial",
        initial_stage: "nonexistent",
      },
      investigate: { type: "agent", on_complete: "done" },
      done: { type: "terminal" },
    });

    const result = validateStagesConfig(stagesConfig);

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining("fast_track.initial_stage 'nonexistent'"),
      ]),
    );
  });
});
