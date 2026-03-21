import { describe, expect, it } from "vitest";

import {
  resolveStagesConfig,
  validateStagesConfig,
} from "../../src/config/config-resolver.js";
import type { StagesConfig } from "../../src/config/types.js";

describe("resolveStagesConfig", () => {
  it("returns null when stages is undefined or not an object", () => {
    expect(resolveStagesConfig(undefined)).toBeNull();
    expect(resolveStagesConfig(null)).toBeNull();
    expect(resolveStagesConfig("not-an-object")).toBeNull();
    expect(resolveStagesConfig([])).toBeNull();
  });

  it("returns null when no stage entries have a valid type", () => {
    expect(
      resolveStagesConfig({
        investigate: { type: "invalid" },
        implement: {},
      }),
    ).toBeNull();
  });

  it("parses a minimal two-stage workflow", () => {
    const result = resolveStagesConfig({
      implement: {
        type: "agent",
        runner: "claude-code",
        model: "claude-sonnet-4-5",
        max_turns: 30,
        prompt: "implement.liquid",
        on_complete: "done",
      },
      done: {
        type: "terminal",
      },
    });

    expect(result).not.toBeNull();
    expect(result!.initialStage).toBe("implement");
    expect(Object.keys(result!.stages)).toEqual(["implement", "done"]);

    const implement = result!.stages.implement!;
    expect(implement.type).toBe("agent");
    expect(implement.runner).toBe("claude-code");
    expect(implement.model).toBe("claude-sonnet-4-5");
    expect(implement.maxTurns).toBe(30);
    expect(implement.prompt).toBe("implement.liquid");
    expect(implement.transitions.onComplete).toBe("done");
    expect(implement.transitions.onApprove).toBeNull();
    expect(implement.transitions.onRework).toBeNull();

    const done = result!.stages.done!;
    expect(done.type).toBe("terminal");
  });

  it("respects explicit initial_stage", () => {
    const result = resolveStagesConfig({
      initial_stage: "investigate",
      investigate: {
        type: "agent",
        on_complete: "implement",
      },
      implement: {
        type: "agent",
        on_complete: "done",
      },
      done: {
        type: "terminal",
      },
    });

    expect(result!.initialStage).toBe("investigate");
  });

  it("uses first stage as initial_stage when not specified", () => {
    const result = resolveStagesConfig({
      investigate: {
        type: "agent",
        on_complete: "done",
      },
      done: {
        type: "terminal",
      },
    });

    expect(result!.initialStage).toBe("investigate");
  });

  it("parses gate stages with gate_type, on_approve, on_rework, and max_rework", () => {
    const result = resolveStagesConfig({
      review: {
        type: "gate",
        gate_type: "ensemble",
        on_approve: "merge",
        on_rework: "implement",
        max_rework: 3,
      },
      implement: {
        type: "agent",
        on_complete: "review",
      },
      merge: {
        type: "agent",
        on_complete: "done",
      },
      done: {
        type: "terminal",
      },
    });

    const review = result!.stages.review!;
    expect(review.type).toBe("gate");
    expect(review.gateType).toBe("ensemble");
    expect(review.maxRework).toBe(3);
    expect(review.transitions.onApprove).toBe("merge");
    expect(review.transitions.onRework).toBe("implement");
  });

  it("parses stage-level concurrency and timeout overrides", () => {
    const result = resolveStagesConfig({
      investigate: {
        type: "agent",
        concurrency: 2,
        timeout_ms: 60000,
        on_complete: "done",
      },
      done: {
        type: "terminal",
      },
    });

    expect(result!.stages.investigate!.concurrency).toBe(2);
    expect(result!.stages.investigate!.timeoutMs).toBe(60000);
  });

  it("parses linear_state from stage definition", () => {
    const result = resolveStagesConfig({
      investigate: {
        type: "agent",
        linear_state: "In Progress",
        on_complete: "done",
      },
      done: {
        type: "terminal",
      },
    });

    expect(result!.stages.investigate!.linearState).toBe("In Progress");
  });

  it("defaults linearState to null when not specified", () => {
    const result = resolveStagesConfig({
      implement: {
        type: "agent",
        on_complete: "done",
      },
      done: {
        type: "terminal",
      },
    });

    expect(result!.stages.implement!.linearState).toBeNull();
    expect(result!.stages.done!.linearState).toBeNull();
  });

  it("treats unrecognized gate_type as null", () => {
    const result = resolveStagesConfig({
      review: {
        type: "gate",
        gate_type: "unknown",
        on_approve: "done",
      },
      done: {
        type: "terminal",
      },
    });

    expect(result!.stages.review!.gateType).toBeNull();
  });
});

describe("validateStagesConfig", () => {
  it("returns ok for null stages (no stages configured)", () => {
    const result = validateStagesConfig(null);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("returns ok for a valid stage machine", () => {
    const stages: StagesConfig = {
      initialStage: "investigate",
      fastTrack: null,
      stages: {
        investigate: {
          type: "agent",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework: null,
          reviewers: [],
          transitions: {
            onComplete: "review",
            onApprove: null,
            onRework: null,
          },
          linearState: null,
        },
        review: {
          type: "gate",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: "ensemble",
          maxRework: 3,
          reviewers: [],
          transitions: {
            onComplete: null,
            onApprove: "done",
            onRework: "investigate",
          },
          linearState: null,
        },
        done: {
          type: "terminal",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework: null,
          reviewers: [],
          transitions: { onComplete: null, onApprove: null, onRework: null },
          linearState: null,
        },
      },
    };
    const result = validateStagesConfig(stages);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects when initial_stage references unknown stage", () => {
    const stages: StagesConfig = {
      initialStage: "nonexistent",
      fastTrack: null,
      stages: {
        implement: {
          type: "agent",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework: null,
          reviewers: [],
          transitions: { onComplete: "done", onApprove: null, onRework: null },
          linearState: null,
        },
        done: {
          type: "terminal",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework: null,
          reviewers: [],
          transitions: { onComplete: null, onApprove: null, onRework: null },
          linearState: null,
        },
      },
    };
    const result = validateStagesConfig(stages);
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("initial_stage 'nonexistent'"),
    );
  });

  it("rejects agent stage without on_complete transition", () => {
    const stages: StagesConfig = {
      initialStage: "implement",
      fastTrack: null,
      stages: {
        implement: {
          type: "agent",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework: null,
          reviewers: [],
          transitions: { onComplete: null, onApprove: null, onRework: null },
          linearState: null,
        },
        done: {
          type: "terminal",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework: null,
          reviewers: [],
          transitions: { onComplete: null, onApprove: null, onRework: null },
          linearState: null,
        },
      },
    };
    const result = validateStagesConfig(stages);
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("'implement' (agent) has no on_complete"),
    );
  });

  it("rejects gate stage without on_approve transition", () => {
    const stages: StagesConfig = {
      initialStage: "review",
      fastTrack: null,
      stages: {
        review: {
          type: "gate",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: "ensemble",
          maxRework: null,
          reviewers: [],
          transitions: { onComplete: null, onApprove: null, onRework: null },
          linearState: null,
        },
        done: {
          type: "terminal",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework: null,
          reviewers: [],
          transitions: { onComplete: null, onApprove: null, onRework: null },
          linearState: null,
        },
      },
    };
    const result = validateStagesConfig(stages);
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("'review' (gate) has no on_approve"),
    );
  });

  it("rejects transitions referencing unknown stages", () => {
    const stages: StagesConfig = {
      initialStage: "implement",
      fastTrack: null,
      stages: {
        implement: {
          type: "agent",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework: null,
          reviewers: [],
          transitions: {
            onComplete: "nonexistent",
            onApprove: null,
            onRework: null,
          },
          linearState: null,
        },
        done: {
          type: "terminal",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework: null,
          reviewers: [],
          transitions: { onComplete: null, onApprove: null, onRework: null },
          linearState: null,
        },
      },
    };
    const result = validateStagesConfig(stages);
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining(
        "on_complete references unknown stage 'nonexistent'",
      ),
    );
  });

  it("rejects when no terminal stage is defined", () => {
    const stages: StagesConfig = {
      initialStage: "a",
      fastTrack: null,
      stages: {
        a: {
          type: "agent",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework: null,
          reviewers: [],
          transitions: { onComplete: "b", onApprove: null, onRework: null },
          linearState: null,
        },
        b: {
          type: "agent",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework: null,
          reviewers: [],
          transitions: { onComplete: "a", onApprove: null, onRework: null },
          linearState: null,
        },
      },
    };
    const result = validateStagesConfig(stages);
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("No terminal stage defined"),
    );
  });

  it("detects unreachable stages", () => {
    const stages: StagesConfig = {
      initialStage: "implement",
      fastTrack: null,
      stages: {
        implement: {
          type: "agent",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework: null,
          reviewers: [],
          transitions: { onComplete: "done", onApprove: null, onRework: null },
          linearState: null,
        },
        orphan: {
          type: "agent",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework: null,
          reviewers: [],
          transitions: { onComplete: "done", onApprove: null, onRework: null },
          linearState: null,
        },
        done: {
          type: "terminal",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework: null,
          reviewers: [],
          transitions: { onComplete: null, onApprove: null, onRework: null },
          linearState: null,
        },
      },
    };
    const result = validateStagesConfig(stages);
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining("'orphan' is unreachable"),
    );
  });

  it("validates agent stage on_rework referencing valid stage", () => {
    const stages: StagesConfig = {
      initialStage: "implement",
      fastTrack: null,
      stages: {
        implement: {
          type: "agent",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework: null,
          reviewers: [],
          transitions: {
            onComplete: "review",
            onApprove: null,
            onRework: null,
          },
          linearState: null,
        },
        review: {
          type: "agent",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework: 3,
          reviewers: [],
          transitions: {
            onComplete: "done",
            onApprove: null,
            onRework: "implement",
          },
          linearState: null,
        },
        done: {
          type: "terminal",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework: null,
          reviewers: [],
          transitions: { onComplete: null, onApprove: null, onRework: null },
          linearState: null,
        },
      },
    };
    const result = validateStagesConfig(stages);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects agent stage on_rework referencing unknown stage", () => {
    const stages: StagesConfig = {
      initialStage: "implement",
      fastTrack: null,
      stages: {
        implement: {
          type: "agent",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework: null,
          reviewers: [],
          transitions: {
            onComplete: "review",
            onApprove: null,
            onRework: null,
          },
          linearState: null,
        },
        review: {
          type: "agent",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework: 3,
          reviewers: [],
          transitions: {
            onComplete: "done",
            onApprove: null,
            onRework: "nonexistent",
          },
          linearState: null,
        },
        done: {
          type: "terminal",
          runner: null,
          model: null,
          prompt: null,
          maxTurns: null,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework: null,
          reviewers: [],
          transitions: { onComplete: null, onApprove: null, onRework: null },
          linearState: null,
        },
      },
    };
    const result = validateStagesConfig(stages);
    expect(result.ok).toBe(false);
    expect(result.errors).toContainEqual(
      expect.stringContaining(
        "'review' on_rework references unknown stage 'nonexistent'",
      ),
    );
  });
});
