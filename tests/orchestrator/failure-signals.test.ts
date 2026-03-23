import { describe, expect, it, vi } from "vitest";

import type {
  ResolvedWorkflowConfig,
  StageDefinition,
  StagesConfig,
} from "../../src/config/types.js";
import type { Issue } from "../../src/domain/model.js";
import {
  OrchestratorCore,
  type OrchestratorCoreOptions,
} from "../../src/orchestrator/core.js";
import type { IssueTracker } from "../../src/tracker/tracker.js";

describe("failure signal routing in onWorkerExit", () => {
  it("advances stage normally when no failure signal is present", async () => {
    const orchestrator = createStagedOrchestrator();

    await orchestrator.pollTick();
    expect(orchestrator.getState().issueStages["1"]).toBe("investigate");

    const retryEntry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_COMPLETE]",
    });

    expect(orchestrator.getState().issueStages["1"]).toBe("implement");
    expect(retryEntry).not.toBeNull();
    expect(retryEntry!.error).toBeNull();
  });

  it("advances stage normally when agentMessage is undefined", async () => {
    const orchestrator = createStagedOrchestrator();

    await orchestrator.pollTick();
    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
    });

    expect(orchestrator.getState().issueStages["1"]).toBe("implement");
  });

  it("schedules retry with backoff on [STAGE_FAILED: verify]", async () => {
    const orchestrator = createStagedOrchestrator();

    await orchestrator.pollTick();
    const retryEntry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "Tests failed.\n[STAGE_FAILED: verify]\nSee logs.",
    });

    // Stage should NOT advance — stays at investigate
    expect(orchestrator.getState().issueStages["1"]).toBe("investigate");
    expect(retryEntry).not.toBeNull();
    expect(retryEntry!.error).toBe("agent reported failure: verify");
  });

  it("schedules retry with backoff on [STAGE_FAILED: infra]", async () => {
    const orchestrator = createStagedOrchestrator();

    await orchestrator.pollTick();
    const retryEntry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: infra]",
    });

    expect(orchestrator.getState().issueStages["1"]).toBe("investigate");
    expect(retryEntry).not.toBeNull();
    expect(retryEntry!.error).toBe("agent reported failure: infra");
  });

  it("escalates immediately on [STAGE_FAILED: spec] — no retry", async () => {
    const orchestrator = createStagedOrchestrator();

    await orchestrator.pollTick();
    const retryEntry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: spec]",
    });

    expect(retryEntry).toBeNull();
    expect(orchestrator.getState().completed.has("1")).toBe(true);
    expect(orchestrator.getState().claimed.has("1")).toBe(false);
    expect(orchestrator.getState().issueStages["1"]).toBeUndefined();
    expect(orchestrator.getState().issueReworkCounts["1"]).toBeUndefined();
  });

  it("prevents redispatch of escalated issues still in Blocked state", async () => {
    // After escalation, Linear state becomes "Blocked".  The completed flag
    // keeps the issue blocked while it remains in the escalation state.
    let issueState = "In Progress";
    const orchestrator = createStagedOrchestrator({
      escalationState: "Blocked",
      candidates: [
        createIssue({ id: "1", identifier: "ISSUE-1", state: issueState }),
      ],
      trackerFactory: () =>
        createTracker({
          candidatesFn: () => [
            createIssue({ id: "1", identifier: "ISSUE-1", state: issueState }),
          ],
        }),
    });

    await orchestrator.pollTick();
    // Simulate escalation side-effect moving issue to Blocked
    issueState = "Blocked";
    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: spec]",
    });

    expect(orchestrator.getState().completed.has("1")).toBe(true);

    const result = await orchestrator.pollTick();
    expect(result.dispatchedIssueIds).not.toContain("1");
    expect(orchestrator.getState().running["1"]).toBeUndefined();
  });

  it("allows redispatch of resumed issues moved out of Blocked state", async () => {
    let issueState = "In Progress";
    const orchestrator = createStagedOrchestrator({
      escalationState: "Blocked",
      trackerFactory: () =>
        createTracker({
          candidatesFn: () => [
            createIssue({ id: "1", identifier: "ISSUE-1", state: issueState }),
          ],
        }),
    });

    await orchestrator.pollTick();
    issueState = "Blocked";
    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: spec]",
    });
    expect(orchestrator.getState().completed.has("1")).toBe(true);

    // Human moves issue to "Resume" → next poll should re-dispatch
    issueState = "Todo";
    const result = await orchestrator.pollTick();
    expect(result.dispatchedIssueIds).toContain("1");
    expect(orchestrator.getState().completed.has("1")).toBe(false);
  });

  it("triggers rework on [STAGE_FAILED: review] with gate workflow", async () => {
    const orchestrator = createStagedOrchestrator({
      stages: createGateWorkflowConfig(),
    });

    // First dispatch puts issue in "implement" stage
    await orchestrator.pollTick();
    expect(orchestrator.getState().issueStages["1"]).toBe("implement");

    const retryEntry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: review]",
    });

    // Should rework back to implement (gate's onRework target)
    expect(orchestrator.getState().issueStages["1"]).toBe("implement");
    expect(orchestrator.getState().issueReworkCounts["1"]).toBe(1);
    expect(retryEntry).not.toBeNull();
    expect(retryEntry!.error).toBe("agent review failure: rework to implement");
  });

  it("escalates review failure when max rework exceeded", async () => {
    const base = createGateWorkflowConfig();
    const stages: StagesConfig = {
      ...base,
      stages: {
        ...base.stages,
        review: { ...base.stages.review!, maxRework: 1 },
      },
    };

    const orchestrator = createStagedOrchestrator({ stages });

    await orchestrator.pollTick();

    // First review failure — rework (count 1 of max 1)
    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: review]",
    });
    expect(orchestrator.getState().issueReworkCounts["1"]).toBe(1);
    expect(orchestrator.getState().issueStages["1"]).toBe("implement");

    // Re-dispatch from rework
    await orchestrator.onRetryTimer("1");

    // Second review failure — should escalate (count would exceed max)
    const retryEntry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: review]",
    });

    expect(retryEntry).toBeNull();
    expect(orchestrator.getState().completed.has("1")).toBe(true);
    expect(orchestrator.getState().issueStages["1"]).toBeUndefined();
    expect(orchestrator.getState().issueReworkCounts["1"]).toBeUndefined();
  });

  it("falls back to retry for review failure when no stages configured", async () => {
    const orchestrator = createStagedOrchestrator({ stages: null });

    await orchestrator.pollTick();
    const retryEntry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: review]",
    });

    expect(retryEntry).not.toBeNull();
    expect(retryEntry!.error).toBe("agent reported failure: review");
  });

  it("falls back to retry for review failure when no downstream gate exists", async () => {
    // Three stage config has no gate stages
    const orchestrator = createStagedOrchestrator();

    await orchestrator.pollTick();
    const retryEntry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: review]",
    });

    // No gate found → falls back to retry
    expect(retryEntry).not.toBeNull();
    expect(retryEntry!.error).toBe("agent reported failure: review");
  });

  it("does not parse failure signals on abnormal exits", async () => {
    const orchestrator = createStagedOrchestrator();

    await orchestrator.pollTick();
    const retryEntry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "abnormal",
      reason: "process crashed",
      agentMessage: "[STAGE_FAILED: spec]",
    });

    // Abnormal exit should use existing retry behavior, ignoring failure signal
    expect(retryEntry).not.toBeNull();
    expect(retryEntry!.error).toBe("worker exited: process crashed");
    expect(orchestrator.getState().issueStages["1"]).toBe("investigate");
  });

  it("increments rework count across multiple review failures", async () => {
    const orchestrator = createStagedOrchestrator({
      stages: createGateWorkflowConfig(),
    });

    await orchestrator.pollTick();

    // First review failure
    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: review]",
    });
    expect(orchestrator.getState().issueReworkCounts["1"]).toBe(1);

    // Re-dispatch
    await orchestrator.onRetryTimer("1");

    // Second review failure
    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: review]",
    });
    expect(orchestrator.getState().issueReworkCounts["1"]).toBe(2);
  });

  it("passes correct reworkCount to spawnWorker during rework cycle", async () => {
    const spawnCalls: Array<{ reworkCount: number }> = [];
    const orchestrator = createStagedOrchestrator({
      stages: createGateWorkflowConfig(),
      onSpawn: (input) => {
        spawnCalls.push({ reworkCount: input.reworkCount });
      },
    });

    // Initial dispatch — reworkCount should be 0
    await orchestrator.pollTick();
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.reworkCount).toBe(0);

    // First review failure → rework
    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: review]",
    });
    await orchestrator.onRetryTimer("1");
    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[1]!.reworkCount).toBe(1);

    // Second review failure → rework
    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: review]",
    });
    await orchestrator.onRetryTimer("1");
    expect(spawnCalls).toHaveLength(3);
    expect(spawnCalls[2]!.reworkCount).toBe(2);
  });

  it("calls updateIssueState on spec failure when escalationState is configured", async () => {
    const updateIssueState = vi.fn().mockResolvedValue(undefined);
    const postComment = vi.fn().mockResolvedValue(undefined);

    const orchestrator = createStagedOrchestrator({
      escalationState: "Blocked",
      updateIssueState,
      postComment,
    });

    await orchestrator.pollTick();
    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: spec]",
    });

    // Allow async side effects to fire
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(updateIssueState).toHaveBeenCalledWith("1", "ISSUE-1", "Blocked");
    expect(postComment).toHaveBeenCalledWith(
      "1",
      expect.stringContaining("spec failure"),
    );
  });

  it("calls updateIssueState on review escalation when escalationState is configured", async () => {
    const updateIssueState = vi.fn().mockResolvedValue(undefined);
    const postComment = vi.fn().mockResolvedValue(undefined);

    const base = createGateWorkflowConfig();
    const stages: StagesConfig = {
      ...base,
      stages: {
        ...base.stages,
        review: { ...base.stages.review!, maxRework: 0 },
      },
    };

    const orchestrator = createStagedOrchestrator({
      stages,
      escalationState: "Blocked",
      updateIssueState,
      postComment,
    });

    await orchestrator.pollTick();
    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: review]",
    });

    // Allow async side effects to fire
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(updateIssueState).toHaveBeenCalledWith("1", "ISSUE-1", "Blocked");
    expect(postComment).toHaveBeenCalledWith(
      "1",
      expect.stringContaining("max rework"),
    );
  });

  it("does not call updateIssueState when escalationState is null", async () => {
    const updateIssueState = vi.fn().mockResolvedValue(undefined);

    const orchestrator = createStagedOrchestrator({
      escalationState: null,
      updateIssueState,
    });

    await orchestrator.pollTick();
    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: spec]",
    });

    // Allow async side effects to fire
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(updateIssueState).not.toHaveBeenCalled();
  });
});

describe("agent-type review stage rework routing", () => {
  it("triggers rework on [STAGE_FAILED: review] from agent-type stage with onRework", async () => {
    const orchestrator = createStagedOrchestrator({
      stages: createAgentReviewWorkflowConfig(),
    });

    // First dispatch puts issue in "implement" stage
    await orchestrator.pollTick();
    expect(orchestrator.getState().issueStages["1"]).toBe("implement");

    // Normal exit advances to "review" (agent-type with onRework)
    orchestrator.onWorkerExit({ issueId: "1", outcome: "normal" });
    expect(orchestrator.getState().issueStages["1"]).toBe("review");

    // Re-dispatch review agent
    await orchestrator.onRetryTimer("1");

    // Review agent reports failure
    const retryEntry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: review]",
    });

    // Should rework back to implement (agent stage's onRework target)
    expect(orchestrator.getState().issueStages["1"]).toBe("implement");
    expect(orchestrator.getState().issueReworkCounts["1"]).toBe(1);
    expect(retryEntry).not.toBeNull();
    expect(retryEntry!.error).toBe("agent review failure: rework to implement");
  });

  it("increments reworkCount across multiple agent review→implement cycles", async () => {
    const orchestrator = createStagedOrchestrator({
      stages: createAgentReviewWorkflowConfig(),
    });

    await orchestrator.pollTick();

    // Advance through implement → review
    orchestrator.onWorkerExit({ issueId: "1", outcome: "normal" });
    await orchestrator.onRetryTimer("1");

    // First review failure
    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: review]",
    });
    expect(orchestrator.getState().issueReworkCounts["1"]).toBe(1);
    expect(orchestrator.getState().issueStages["1"]).toBe("implement");

    // Re-dispatch implement, advance back to review
    await orchestrator.onRetryTimer("1");
    orchestrator.onWorkerExit({ issueId: "1", outcome: "normal" });
    await orchestrator.onRetryTimer("1");

    // Second review failure
    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: review]",
    });
    expect(orchestrator.getState().issueReworkCounts["1"]).toBe(2);
    expect(orchestrator.getState().issueStages["1"]).toBe("implement");
  });

  it("escalates when maxRework exceeded on agent-type review stage", async () => {
    const base = createAgentReviewWorkflowConfig();
    const stages: StagesConfig = {
      ...base,
      stages: {
        ...base.stages,
        review: { ...base.stages.review!, maxRework: 1 },
      },
    };

    const updateIssueState = vi.fn().mockResolvedValue(undefined);
    const postComment = vi.fn().mockResolvedValue(undefined);

    const orchestrator = createStagedOrchestrator({
      stages,
      escalationState: "Blocked",
      updateIssueState,
      postComment,
    });

    await orchestrator.pollTick();

    // Advance to review
    orchestrator.onWorkerExit({ issueId: "1", outcome: "normal" });
    await orchestrator.onRetryTimer("1");

    // First review failure — rework (count 1 of max 1)
    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: review]",
    });
    expect(orchestrator.getState().issueReworkCounts["1"]).toBe(1);
    expect(orchestrator.getState().issueStages["1"]).toBe("implement");

    // Re-dispatch implement, advance back to review
    await orchestrator.onRetryTimer("1");
    orchestrator.onWorkerExit({ issueId: "1", outcome: "normal" });
    await orchestrator.onRetryTimer("1");

    // Second review failure — should escalate (count would exceed max)
    const retryEntry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: review]",
    });

    expect(retryEntry).toBeNull();
    expect(orchestrator.getState().completed.has("1")).toBe(true);
    expect(orchestrator.getState().issueStages["1"]).toBeUndefined();
    expect(orchestrator.getState().issueReworkCounts["1"]).toBeUndefined();

    // Allow async side effects to fire
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(updateIssueState).toHaveBeenCalledWith("1", "ISSUE-1", "Blocked");
    expect(postComment).toHaveBeenCalledWith(
      "1",
      expect.stringContaining("max rework"),
    );
  });

  it("routes implement-stage review failure through downstream agent-type review stage with onRework", async () => {
    const orchestrator = createStagedOrchestrator({
      stages: createAgentReviewWorkflowConfig(),
    });

    // Dispatch puts issue in "implement" stage
    await orchestrator.pollTick();
    expect(orchestrator.getState().issueStages["1"]).toBe("implement");

    // Implement agent reports [STAGE_FAILED: review] — should find downstream
    // agent-type review stage via findDownstreamGate and use its onRework
    const retryEntry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: review]",
    });

    // Should rework back to implement via the downstream review stage's onRework
    expect(orchestrator.getState().issueStages["1"]).toBe("implement");
    expect(orchestrator.getState().issueReworkCounts["1"]).toBe(1);
    expect(retryEntry).not.toBeNull();
    expect(retryEntry!.error).toBe("agent review failure: rework to implement");
  });

  it("agent-type stage WITHOUT onRework falls back to retry on review failure", async () => {
    // Three-stage config has no onRework on any stage and no gate stages
    const orchestrator = createStagedOrchestrator();

    await orchestrator.pollTick();
    const retryEntry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: review]",
    });

    // No onRework, no downstream gate → falls back to retry
    expect(retryEntry).not.toBeNull();
    expect(retryEntry!.error).toBe("agent reported failure: review");
  });

  it("passes correct reworkCount to spawnWorker during agent review rework cycle", async () => {
    const spawnCalls: Array<{ reworkCount: number; stageName: string | null }> =
      [];
    const orchestrator = createStagedOrchestrator({
      stages: createAgentReviewWorkflowConfig(),
      onSpawn: (input) => {
        spawnCalls.push({
          reworkCount: input.reworkCount,
          stageName: input.stageName,
        });
      },
    });

    // Initial dispatch — implement stage, reworkCount 0
    await orchestrator.pollTick();
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]!.reworkCount).toBe(0);
    expect(spawnCalls[0]!.stageName).toBe("implement");

    // Advance to review
    orchestrator.onWorkerExit({ issueId: "1", outcome: "normal" });
    await orchestrator.onRetryTimer("1");
    expect(spawnCalls).toHaveLength(2);
    expect(spawnCalls[1]!.stageName).toBe("review");

    // Review fails → rework to implement
    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: review]",
    });
    await orchestrator.onRetryTimer("1");
    expect(spawnCalls).toHaveLength(3);
    expect(spawnCalls[2]!.reworkCount).toBe(1);
    expect(spawnCalls[2]!.stageName).toBe("implement");
  });
});

describe("review findings comment posting on agent review failure", () => {
  it("posts review findings comment on agent review failure", async () => {
    const postComment = vi.fn().mockResolvedValue(undefined);

    const orchestrator = createStagedOrchestrator({
      stages: createAgentReviewWorkflowConfig(),
      postComment,
    });

    // Dispatch to implement stage
    await orchestrator.pollTick();
    expect(orchestrator.getState().issueStages["1"]).toBe("implement");

    // Advance to review stage
    orchestrator.onWorkerExit({ issueId: "1", outcome: "normal" });
    expect(orchestrator.getState().issueStages["1"]).toBe("review");
    await orchestrator.onRetryTimer("1");

    // Review agent reports failure with message
    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage:
        "Missing null check in handler.ts line 42\n[STAGE_FAILED: review]",
    });

    // Allow async side effects to fire
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(postComment).toHaveBeenCalledWith(
      "1",
      expect.stringContaining("## Review Findings"),
    );
  });

  it("review findings comment includes agent message", async () => {
    const postComment = vi.fn().mockResolvedValue(undefined);

    const orchestrator = createStagedOrchestrator({
      stages: createAgentReviewWorkflowConfig(),
      postComment,
    });

    await orchestrator.pollTick();

    // Advance to review stage
    orchestrator.onWorkerExit({ issueId: "1", outcome: "normal" });
    await orchestrator.onRetryTimer("1");

    // Review agent reports failure with specific message
    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage:
        "Missing null check in handler.ts line 42\n[STAGE_FAILED: review]",
    });

    // Allow async side effects to fire
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(postComment).toHaveBeenCalledTimes(1);
    const commentBody = postComment.mock.calls[0]![1] as string;
    expect(commentBody).toContain("Missing null check in handler.ts line 42");
    expect(commentBody).toContain("review");
  });

  it("review failure triggers rework after posting comment", async () => {
    const postComment = vi.fn().mockResolvedValue(undefined);

    const orchestrator = createStagedOrchestrator({
      stages: createAgentReviewWorkflowConfig(),
      postComment,
    });

    await orchestrator.pollTick();

    // Advance to review stage
    orchestrator.onWorkerExit({ issueId: "1", outcome: "normal" });
    await orchestrator.onRetryTimer("1");

    // Review agent reports failure
    const retryEntry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage:
        "Missing null check in handler.ts line 42\n[STAGE_FAILED: review]",
    });

    // Should rework back to implement
    expect(orchestrator.getState().issueStages["1"]).toBe("implement");
    expect(orchestrator.getState().issueReworkCounts["1"]).toBe(1);
    expect(retryEntry).not.toBeNull();
    expect(retryEntry!.error).toBe("agent review failure: rework to implement");

    // Allow async side effects to fire
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Comment was posted before rework
    expect(postComment).toHaveBeenCalledWith(
      "1",
      expect.stringContaining("## Review Findings"),
    );
  });

  it("does not let comment posting failure affect rework flow", async () => {
    const postComment = vi.fn().mockRejectedValue(new Error("network error"));

    const orchestrator = createStagedOrchestrator({
      stages: createAgentReviewWorkflowConfig(),
      postComment,
    });

    await orchestrator.pollTick();

    // Advance to review stage
    orchestrator.onWorkerExit({ issueId: "1", outcome: "normal" });
    await orchestrator.onRetryTimer("1");

    // Review agent reports failure — comment posting will fail
    const retryEntry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: review]",
    });

    // Rework should still succeed despite comment failure
    expect(orchestrator.getState().issueStages["1"]).toBe("implement");
    expect(retryEntry).not.toBeNull();
    expect(retryEntry!.error).toBe("agent review failure: rework to implement");

    // Allow async side effects to fire (and fail silently)
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(postComment).toHaveBeenCalled();
  });

  it("review findings comment failure does not block rework", async () => {
    const postComment = vi.fn().mockRejectedValue(new Error("network error"));

    const orchestrator = createStagedOrchestrator({
      stages: createAgentReviewWorkflowConfig(),
      postComment,
    });

    await orchestrator.pollTick();

    // Advance to review stage
    orchestrator.onWorkerExit({ issueId: "1", outcome: "normal" });
    await orchestrator.onRetryTimer("1");

    // Review agent reports failure — comment will fail to post
    const retryEntry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: review]",
    });

    // Rework must proceed regardless of comment failure
    expect(orchestrator.getState().issueStages["1"]).toBe("implement");
    expect(retryEntry).not.toBeNull();
    expect(retryEntry!.error).toBe("agent review failure: rework to implement");

    // Allow async side effects to fire (and fail silently)
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(postComment).toHaveBeenCalled();
  });

  it("postComment error is swallowed for review findings", async () => {
    const postComment = vi.fn().mockRejectedValue(new Error("timeout"));

    const orchestrator = createStagedOrchestrator({
      stages: createAgentReviewWorkflowConfig(),
      postComment,
    });

    await orchestrator.pollTick();

    // Advance to review stage
    orchestrator.onWorkerExit({ issueId: "1", outcome: "normal" });
    await orchestrator.onRetryTimer("1");

    // Review fails — postComment will throw
    let thrownError: unknown = null;
    try {
      orchestrator.onWorkerExit({
        issueId: "1",
        outcome: "normal",
        agentMessage: "[STAGE_FAILED: review]",
      });
    } catch (err) {
      thrownError = err;
    }

    // Error must not propagate to caller
    expect(thrownError).toBeNull();

    // Allow async side effects to settle
    await new Promise((resolve) => setTimeout(resolve, 10));

    // postComment was called but the error was swallowed
    expect(postComment).toHaveBeenCalled();
  });

  it("skips review findings when postComment not configured", async () => {
    // No postComment wired — orchestrator created without it
    const orchestrator = createStagedOrchestrator({
      stages: createAgentReviewWorkflowConfig(),
    });

    await orchestrator.pollTick();

    // Advance to review stage
    orchestrator.onWorkerExit({ issueId: "1", outcome: "normal" });
    await orchestrator.onRetryTimer("1");

    // Review agent reports failure — no postComment configured
    const retryEntry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: review]",
    });

    // Rework should still proceed
    expect(orchestrator.getState().issueStages["1"]).toBe("implement");
    expect(retryEntry).not.toBeNull();
    expect(retryEntry!.error).toBe("agent review failure: rework to implement");
  });

  it("escalation fires on max rework exceeded", async () => {
    const base = createAgentReviewWorkflowConfig();
    const stages: StagesConfig = {
      ...base,
      stages: {
        ...base.stages,
        review: { ...base.stages.review!, maxRework: 1 },
      },
    };

    const updateIssueState = vi.fn().mockResolvedValue(undefined);
    const postComment = vi.fn().mockResolvedValue(undefined);

    const orchestrator = createStagedOrchestrator({
      stages,
      escalationState: "Blocked",
      updateIssueState,
      postComment,
    });

    await orchestrator.pollTick();

    // Advance to review
    orchestrator.onWorkerExit({ issueId: "1", outcome: "normal" });
    await orchestrator.onRetryTimer("1");

    // First review failure — rework (count 1 of max 1)
    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: review]",
    });
    await orchestrator.onRetryTimer("1");
    orchestrator.onWorkerExit({ issueId: "1", outcome: "normal" });
    await orchestrator.onRetryTimer("1");

    // Second review failure — should escalate
    const retryEntry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: review]",
    });

    expect(retryEntry).toBeNull();
    expect(orchestrator.getState().completed.has("1")).toBe(true);

    // Allow async side effects to fire
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(updateIssueState).toHaveBeenCalledWith("1", "ISSUE-1", "Blocked");
    expect(postComment).toHaveBeenCalledWith(
      "1",
      expect.stringContaining("max rework"),
    );
  });

  it("no review findings on escalation", async () => {
    const base = createAgentReviewWorkflowConfig();
    const stages: StagesConfig = {
      ...base,
      stages: {
        ...base.stages,
        review: { ...base.stages.review!, maxRework: 1 },
      },
    };

    const postComment = vi.fn().mockResolvedValue(undefined);

    const orchestrator = createStagedOrchestrator({
      stages,
      escalationState: "Blocked",
      postComment,
    });

    await orchestrator.pollTick();

    // Advance to review
    orchestrator.onWorkerExit({ issueId: "1", outcome: "normal" });
    await orchestrator.onRetryTimer("1");

    // First review failure — rework
    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: review]",
    });

    // Allow the review findings comment to fire for the first failure
    await new Promise((resolve) => setTimeout(resolve, 10));
    postComment.mockClear();

    await orchestrator.onRetryTimer("1");
    orchestrator.onWorkerExit({ issueId: "1", outcome: "normal" });
    await orchestrator.onRetryTimer("1");

    // Second review failure — escalation (max exceeded)
    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: review]",
    });

    // Allow async side effects to fire
    await new Promise((resolve) => setTimeout(resolve, 10));

    // Only the escalation comment should have been posted — not a review findings comment
    expect(postComment).toHaveBeenCalledTimes(1);
    expect(postComment).toHaveBeenCalledWith(
      "1",
      expect.stringContaining("max rework"),
    );
    expect(postComment).not.toHaveBeenCalledWith(
      "1",
      expect.stringContaining("## Review Findings"),
    );
  });
});

describe("rebase failure signal routing", () => {
  it("triggers rework on [STAGE_FAILED: rebase] with onRework configured", async () => {
    const orchestrator = createStagedOrchestrator({
      stages: createMergeWithRebaseWorkflowConfig(),
    });

    // Dispatch to implement stage
    await orchestrator.pollTick();
    expect(orchestrator.getState().issueStages["1"]).toBe("implement");

    // Advance implement → merge
    orchestrator.onWorkerExit({ issueId: "1", outcome: "normal" });
    expect(orchestrator.getState().issueStages["1"]).toBe("merge");
    await orchestrator.onRetryTimer("1");

    // Merge agent reports rebase failure
    const retryEntry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: rebase]",
    });

    // Should rework back to implement (merge stage's onRework target)
    expect(orchestrator.getState().issueStages["1"]).toBe("implement");
    expect(orchestrator.getState().issueReworkCounts["1"]).toBe(1);
    expect(retryEntry).not.toBeNull();
    expect(retryEntry!.error).toBe("rebase failure: rework to implement");
  });

  it("increments rework count on rebase failure", async () => {
    const orchestrator = createStagedOrchestrator({
      stages: createMergeWithRebaseWorkflowConfig(),
    });

    await orchestrator.pollTick();

    // Advance to merge
    orchestrator.onWorkerExit({ issueId: "1", outcome: "normal" });
    await orchestrator.onRetryTimer("1");

    // First rebase failure
    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: rebase]",
    });
    expect(orchestrator.getState().issueReworkCounts["1"]).toBe(1);

    // Re-dispatch implement, advance back to merge
    await orchestrator.onRetryTimer("1");
    orchestrator.onWorkerExit({ issueId: "1", outcome: "normal" });
    await orchestrator.onRetryTimer("1");

    // Second rebase failure
    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: rebase]",
    });
    expect(orchestrator.getState().issueReworkCounts["1"]).toBe(2);
  });

  it("escalates when max rework exceeded on rebase failure", async () => {
    const base = createMergeWithRebaseWorkflowConfig();
    const stages: StagesConfig = {
      ...base,
      stages: {
        ...base.stages,
        merge: { ...base.stages.merge!, maxRework: 1 },
      },
    };

    const updateIssueState = vi.fn().mockResolvedValue(undefined);
    const postComment = vi.fn().mockResolvedValue(undefined);

    const orchestrator = createStagedOrchestrator({
      stages,
      escalationState: "Blocked",
      updateIssueState,
      postComment,
    });

    await orchestrator.pollTick();

    // Advance to merge
    orchestrator.onWorkerExit({ issueId: "1", outcome: "normal" });
    await orchestrator.onRetryTimer("1");

    // First rebase failure — rework (count 1 of max 1)
    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: rebase]",
    });
    expect(orchestrator.getState().issueReworkCounts["1"]).toBe(1);

    // Re-dispatch implement, advance back to merge
    await orchestrator.onRetryTimer("1");
    orchestrator.onWorkerExit({ issueId: "1", outcome: "normal" });
    await orchestrator.onRetryTimer("1");

    // Second rebase failure — should escalate
    const retryEntry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: rebase]",
    });

    expect(retryEntry).toBeNull();
    expect(orchestrator.getState().completed.has("1")).toBe(true);
    expect(orchestrator.getState().issueStages["1"]).toBeUndefined();
    expect(orchestrator.getState().issueReworkCounts["1"]).toBeUndefined();

    // Allow async side effects to fire
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(updateIssueState).toHaveBeenCalledWith("1", "ISSUE-1", "Blocked");
    expect(postComment).toHaveBeenCalledWith(
      "1",
      expect.stringContaining("max rework"),
    );
  });

  it("posts a Rebase Needed comment on rebase failure with onRework", async () => {
    const postComment = vi.fn().mockResolvedValue(undefined);

    const orchestrator = createStagedOrchestrator({
      stages: createMergeWithRebaseWorkflowConfig(),
      postComment,
    });

    await orchestrator.pollTick();

    // Advance to merge
    orchestrator.onWorkerExit({ issueId: "1", outcome: "normal" });
    await orchestrator.onRetryTimer("1");

    // Merge agent reports rebase failure with message
    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "Merge conflict in src/handler.ts\n[STAGE_FAILED: rebase]",
    });

    // Allow async side effects to fire
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(postComment).toHaveBeenCalledWith(
      "1",
      expect.stringContaining("## Rebase Needed"),
    );
  });

  it("falls back to retry for rebase failure when no onRework configured", async () => {
    // Three-stage config has no onRework on any stage
    const orchestrator = createStagedOrchestrator();

    await orchestrator.pollTick();
    const retryEntry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: rebase]",
    });

    // No onRework → falls back to retry
    expect(retryEntry).not.toBeNull();
    expect(retryEntry!.error).toBe("agent reported failure: rebase");
  });

  it("falls back to retry for rebase failure when no stages configured", async () => {
    const orchestrator = createStagedOrchestrator({ stages: null });

    await orchestrator.pollTick();
    const retryEntry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: rebase]",
    });

    expect(retryEntry).not.toBeNull();
    expect(retryEntry!.error).toBe("agent reported failure: rebase");
  });

  it("shares rework counter with review failures", async () => {
    const base = createMergeWithRebaseWorkflowConfig();
    // Add an agent review stage with onRework before merge
    const stages: StagesConfig = {
      ...base,
      stages: {
        ...base.stages,
        implement: {
          ...base.stages.implement!,
          transitions: {
            onComplete: "review",
            onApprove: null,
            onRework: null,
          },
        },
        review: {
          type: "agent",
          runner: "claude-code",
          model: "claude-opus-4-6",
          prompt: "review.liquid",
          maxTurns: 15,
          timeoutMs: null,
          concurrency: null,
          gateType: null,
          maxRework: 2,
          reviewers: [],
          transitions: {
            onComplete: "merge",
            onApprove: null,
            onRework: "implement",
          },
          linearState: null,
        },
        merge: { ...base.stages.merge!, maxRework: 2 },
      },
    };

    const orchestrator = createStagedOrchestrator({ stages });

    await orchestrator.pollTick();
    expect(orchestrator.getState().issueStages["1"]).toBe("implement");

    // Advance implement → review
    orchestrator.onWorkerExit({ issueId: "1", outcome: "normal" });
    await orchestrator.onRetryTimer("1");

    // Two review failures (rework count goes to 2)
    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: review]",
    });
    expect(orchestrator.getState().issueReworkCounts["1"]).toBe(1);

    await orchestrator.onRetryTimer("1");
    orchestrator.onWorkerExit({ issueId: "1", outcome: "normal" });
    await orchestrator.onRetryTimer("1");

    orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: review]",
    });
    expect(orchestrator.getState().issueReworkCounts["1"]).toBe(2);

    // Now advance through review → merge
    await orchestrator.onRetryTimer("1");
    orchestrator.onWorkerExit({ issueId: "1", outcome: "normal" });
    await orchestrator.onRetryTimer("1");
    orchestrator.onWorkerExit({ issueId: "1", outcome: "normal" });
    await orchestrator.onRetryTimer("1");

    // Rebase failure should escalate because total rework count (3) exceeds max (2)
    const retryEntry = orchestrator.onWorkerExit({
      issueId: "1",
      outcome: "normal",
      agentMessage: "[STAGE_FAILED: rebase]",
    });

    expect(retryEntry).toBeNull();
    expect(orchestrator.getState().completed.has("1")).toBe(true);
  });
});

// --- Helpers ---

function createStagedOrchestrator(overrides?: {
  stages?: StagesConfig | null;
  candidates?: Issue[];
  escalationState?: string | null;
  updateIssueState?: OrchestratorCoreOptions["updateIssueState"];
  postComment?: OrchestratorCoreOptions["postComment"];
  trackerFactory?: () => IssueTracker;
  onSpawn?: (input: {
    issue: Issue;
    attempt: number | null;
    stage: StageDefinition | null;
    stageName: string | null;
    reworkCount: number;
  }) => void;
}) {
  const stages =
    overrides?.stages !== undefined
      ? overrides.stages
      : createThreeStageConfig();

  const tracker =
    overrides?.trackerFactory?.() ??
    createTracker({
      candidates: overrides?.candidates ?? [
        createIssue({ id: "1", identifier: "ISSUE-1" }),
      ],
    });

  const options: OrchestratorCoreOptions = {
    config: createConfig({
      stages,
      ...(overrides?.escalationState !== undefined
        ? { escalationState: overrides.escalationState }
        : {}),
    }),
    tracker,
    spawnWorker: async (input) => {
      overrides?.onSpawn?.(input);
      return {
        workerHandle: { pid: 1001 },
        monitorHandle: { ref: "monitor-1" },
      };
    },
    ...(overrides?.updateIssueState !== undefined
      ? { updateIssueState: overrides.updateIssueState }
      : {}),
    ...(overrides?.postComment !== undefined
      ? { postComment: overrides.postComment }
      : {}),
    now: () => new Date("2026-03-06T00:00:05.000Z"),
  };

  return new OrchestratorCore(options);
}

function createThreeStageConfig(): StagesConfig {
  return {
    initialStage: "investigate",
    fastTrack: null,
    stages: {
      investigate: {
        type: "agent",
        runner: "claude-code",
        model: "claude-opus-4",
        prompt: "investigate.liquid",
        maxTurns: 8,
        timeoutMs: null,
        concurrency: null,
        gateType: null,
        maxRework: null,
        reviewers: [],
        transitions: {
          onComplete: "implement",
          onApprove: null,
          onRework: null,
        },
        linearState: null,
      },
      implement: {
        type: "agent",
        runner: "claude-code",
        model: "claude-sonnet-4-5",
        prompt: "implement.liquid",
        maxTurns: 30,
        timeoutMs: null,
        concurrency: null,
        gateType: null,
        maxRework: null,
        reviewers: [],
        transitions: {
          onComplete: "done",
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
}

function createGateWorkflowConfig(): StagesConfig {
  return {
    initialStage: "implement",
    fastTrack: null,
    stages: {
      implement: {
        type: "agent",
        runner: "claude-code",
        model: "claude-sonnet-4-5",
        prompt: "implement.liquid",
        maxTurns: 30,
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
          onApprove: "merge",
          onRework: "implement",
        },
        linearState: null,
      },
      merge: {
        type: "agent",
        runner: "claude-code",
        model: "claude-sonnet-4-5",
        prompt: "merge.liquid",
        maxTurns: 5,
        timeoutMs: null,
        concurrency: null,
        gateType: null,
        maxRework: null,
        reviewers: [],
        transitions: {
          onComplete: "done",
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
}

function createAgentReviewWorkflowConfig(): StagesConfig {
  return {
    initialStage: "implement",
    fastTrack: null,
    stages: {
      implement: {
        type: "agent",
        runner: "claude-code",
        model: "claude-sonnet-4-5",
        prompt: "implement.liquid",
        maxTurns: 30,
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
        runner: "claude-code",
        model: "claude-opus-4-6",
        prompt: "review.liquid",
        maxTurns: 15,
        timeoutMs: null,
        concurrency: null,
        gateType: null,
        maxRework: 3,
        reviewers: [],
        transitions: {
          onComplete: "merge",
          onApprove: null,
          onRework: "implement",
        },
        linearState: null,
      },
      merge: {
        type: "agent",
        runner: "claude-code",
        model: "claude-sonnet-4-5",
        prompt: "merge.liquid",
        maxTurns: 5,
        timeoutMs: null,
        concurrency: null,
        gateType: null,
        maxRework: null,
        reviewers: [],
        transitions: {
          onComplete: "done",
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
}

function createMergeWithRebaseWorkflowConfig(): StagesConfig {
  return {
    initialStage: "implement",
    fastTrack: null,
    stages: {
      implement: {
        type: "agent",
        runner: "claude-code",
        model: "claude-sonnet-4-5",
        prompt: "implement.liquid",
        maxTurns: 30,
        timeoutMs: null,
        concurrency: null,
        gateType: null,
        maxRework: null,
        reviewers: [],
        transitions: {
          onComplete: "merge",
          onApprove: null,
          onRework: null,
        },
        linearState: null,
      },
      merge: {
        type: "agent",
        runner: "claude-code",
        model: "claude-sonnet-4-5",
        prompt: "merge.liquid",
        maxTurns: 5,
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
}

function createTracker(input?: {
  candidates?: Issue[];
  candidatesFn?: () => Issue[];
}): IssueTracker {
  const getCandidates = () =>
    input?.candidatesFn?.() ??
    input?.candidates ?? [createIssue({ id: "1", identifier: "ISSUE-1" })];

  return {
    async fetchCandidateIssues() {
      return getCandidates();
    },
    async fetchIssuesByStates() {
      return [];
    },
    async fetchIssueStatesByIds() {
      const candidates = getCandidates();
      return candidates.map((issue) => ({
        id: issue.id,
        identifier: issue.identifier,
        state: issue.state,
      }));
    },
  };
}

function createConfig(overrides?: {
  stages?: StagesConfig | null;
  escalationState?: string | null;
}): ResolvedWorkflowConfig {
  return {
    workflowPath: "/tmp/WORKFLOW.md",
    promptTemplate: "Prompt",
    tracker: {
      kind: "linear",
      endpoint: "https://api.linear.app/graphql",
      apiKey: "token",
      projectSlug: "project",
      activeStates: ["Todo", "In Progress", "In Review"],
      terminalStates: ["Done", "Canceled"],
    },
    polling: {
      intervalMs: 30_000,
    },
    workspace: {
      root: "/tmp/workspaces",
    },
    hooks: {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 30_000,
    },
    agent: {
      maxConcurrentAgents: 2,
      maxTurns: 5,
      maxRetryBackoffMs: 300_000,
      maxRetryAttempts: 5,
      maxConcurrentAgentsByState: {},
    },
    runner: {
      kind: "codex",
      model: null,
    },
    codex: {
      command: "codex-app-server",
      approvalPolicy: "never",
      threadSandbox: null,
      turnSandboxPolicy: null,
      turnTimeoutMs: 300_000,
      readTimeoutMs: 30_000,
      stallTimeoutMs: 300_000,
    },
    server: {
      port: null,
    },
    observability: {
      dashboardEnabled: true,
      refreshMs: 1_000,
      renderIntervalMs: 16,
    },
    stages: overrides?.stages !== undefined ? overrides.stages : null,
    escalationState: overrides?.escalationState ?? null,
  };
}

function createIssue(overrides?: Partial<Issue>): Issue {
  return {
    id: overrides?.id ?? "1",
    identifier: overrides?.identifier ?? "ISSUE-1",
    title: overrides?.title ?? "Example issue",
    description: overrides?.description ?? null,
    priority: overrides?.priority ?? 1,
    state: overrides?.state ?? "In Progress",
    branchName: overrides?.branchName ?? null,
    url: overrides?.url ?? null,
    labels: overrides?.labels ?? [],
    blockedBy: overrides?.blockedBy ?? [],
    createdAt: overrides?.createdAt ?? "2026-03-01T00:00:00.000Z",
    updatedAt: overrides?.updatedAt ?? "2026-03-01T00:00:00.000Z",
  };
}
