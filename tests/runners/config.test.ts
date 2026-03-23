import { describe, expect, it } from "vitest";

import { resolveWorkflowConfig } from "../../src/config/config-resolver.js";
import { DEFAULT_RUNNER_KIND } from "../../src/config/defaults.js";

describe("runner config resolution", () => {
  it("defaults runner.kind to 'codex' when not specified", () => {
    const config = resolveWorkflowConfig({
      workflowPath: "/tmp/WORKFLOW.md",
      config: {},
      promptTemplate: "test",
    });

    expect(config.runner.kind).toBe("codex");
    expect(config.runner.kind).toBe(DEFAULT_RUNNER_KIND);
    expect(config.runner.model).toBeNull();
  });

  it("reads runner.kind from YAML config", () => {
    const config = resolveWorkflowConfig({
      workflowPath: "/tmp/WORKFLOW.md",
      config: {
        runner: {
          kind: "claude-code",
          model: "opus",
        },
      },
      promptTemplate: "test",
    });

    expect(config.runner.kind).toBe("claude-code");
    expect(config.runner.model).toBe("opus");
  });

  it("reads runner.kind gemini from YAML config", () => {
    const config = resolveWorkflowConfig({
      workflowPath: "/tmp/WORKFLOW.md",
      config: {
        runner: {
          kind: "gemini",
          model: "gemini-2.5-pro",
        },
      },
      promptTemplate: "test",
    });

    expect(config.runner.kind).toBe("gemini");
    expect(config.runner.model).toBe("gemini-2.5-pro");
  });

  it("handles runner with kind only (no model)", () => {
    const config = resolveWorkflowConfig({
      workflowPath: "/tmp/WORKFLOW.md",
      config: {
        runner: {
          kind: "claude-code",
        },
      },
      promptTemplate: "test",
    });

    expect(config.runner.kind).toBe("claude-code");
    expect(config.runner.model).toBeNull();
  });

  it("preserves codex config alongside runner config", () => {
    const config = resolveWorkflowConfig({
      workflowPath: "/tmp/WORKFLOW.md",
      config: {
        runner: {
          kind: "claude-code",
          model: "sonnet",
        },
        codex: {
          command: "codex app-server",
        },
      },
      promptTemplate: "test",
    });

    expect(config.runner.kind).toBe("claude-code");
    expect(config.codex.command).toBe("codex app-server");
  });

  it("stage-level runner overrides top-level runner", () => {
    const config = resolveWorkflowConfig({
      workflowPath: "/tmp/WORKFLOW.md",
      config: {
        runner: {
          kind: "codex",
        },
        stages: {
          investigate: {
            type: "agent",
            runner: "claude-code",
            model: "opus",
            on_complete: "implement",
          },
          implement: {
            type: "agent",
            runner: "codex",
            on_complete: "done",
          },
          done: {
            type: "terminal",
          },
        },
      },
      promptTemplate: "test",
    });

    expect(config.runner.kind).toBe("codex");
    expect(config.stages).not.toBeNull();
    expect(config.stages!.stages.investigate!.runner).toBe("claude-code");
    expect(config.stages!.stages.investigate!.model).toBe("opus");
    expect(config.stages!.stages.implement!.runner).toBe("codex");
  });
});
