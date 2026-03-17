import { describe, expect, it, vi } from "vitest";

import type { AgentRunnerCodexClient } from "../../src/agent/runner.js";
import type { CodexTurnResult } from "../../src/codex/app-server-client.js";
import type {
  ReviewerDefinition,
  StageDefinition,
} from "../../src/config/types.js";
import type { Issue } from "../../src/domain/model.js";
import {
  type AggregateVerdict,
  type CreateReviewerClient,
  type EnsembleGateResult,
  type PostComment,
  type ReviewerResult,
  aggregateVerdicts,
  formatGateComment,
  parseReviewerOutput,
  runEnsembleGate,
} from "../../src/orchestrator/gate-handler.js";

describe("aggregateVerdicts", () => {
  it("returns pass for empty results", () => {
    expect(aggregateVerdicts([])).toBe("pass");
  });

  it("returns pass when all reviewers pass", () => {
    const results = [
      createResult({ verdict: "pass" }),
      createResult({ verdict: "pass" }),
    ];
    expect(aggregateVerdicts(results)).toBe("pass");
  });

  it("returns fail when any reviewer fails", () => {
    const results = [
      createResult({ verdict: "pass" }),
      createResult({ verdict: "fail" }),
    ];
    expect(aggregateVerdicts(results)).toBe("fail");
  });

  it("returns fail when all reviewers fail", () => {
    const results = [
      createResult({ verdict: "fail" }),
      createResult({ verdict: "fail" }),
    ];
    expect(aggregateVerdicts(results)).toBe("fail");
  });

  it("returns pass when one reviewer passes and another errors", () => {
    const results = [
      createResult({ verdict: "pass" }),
      createResult({ verdict: "error" }),
    ];
    expect(aggregateVerdicts(results)).toBe("pass");
  });

  it("returns fail when all reviewers error (no review occurred)", () => {
    const results = [
      createResult({ verdict: "error" }),
      createResult({ verdict: "error" }),
    ];
    expect(aggregateVerdicts(results)).toBe("fail");
  });

  it("returns fail when one reviewer fails and another errors", () => {
    const results = [
      createResult({ verdict: "fail" }),
      createResult({ verdict: "error" }),
    ];
    expect(aggregateVerdicts(results)).toBe("fail");
  });
});

describe("parseReviewerOutput", () => {
  const reviewer: ReviewerDefinition = {
    runner: "codex",
    model: "gpt-5.3-codex",
    role: "adversarial-reviewer",
    prompt: null,
  };

  it("parses valid JSON verdict with feedback", () => {
    const raw = [
      '{"role": "adversarial-reviewer", "model": "gpt-5.3-codex", "verdict": "pass"}',
      "",
      "Code looks good. No issues found.",
    ].join("\n");

    const result = parseReviewerOutput(reviewer, raw);
    expect(result.verdict.verdict).toBe("pass");
    expect(result.verdict.role).toBe("adversarial-reviewer");
    expect(result.verdict.model).toBe("gpt-5.3-codex");
    expect(result.feedback).toContain("Code looks good");
  });

  it("parses verdict embedded in code block", () => {
    const raw = [
      "Here is my review:",
      "```",
      '{"role": "security-reviewer", "model": "gemini-3-pro", "verdict": "fail"}',
      "```",
      "Found SQL injection vulnerability in user input handling.",
    ].join("\n");

    const result = parseReviewerOutput(reviewer, raw);
    expect(result.verdict.verdict).toBe("fail");
    expect(result.verdict.role).toBe("security-reviewer");
    expect(result.feedback).toContain("SQL injection");
  });

  it("defaults to fail for empty output", () => {
    const result = parseReviewerOutput(reviewer, "");
    expect(result.verdict.verdict).toBe("fail");
    expect(result.feedback).toContain("empty output");
  });

  it("defaults to fail when no valid JSON found", () => {
    const result = parseReviewerOutput(reviewer, "Some random feedback text");
    expect(result.verdict.verdict).toBe("fail");
    expect(result.feedback).toBe("Some random feedback text");
  });

  it("uses reviewer defaults when JSON missing role/model", () => {
    const raw = '{"verdict": "pass"}';
    const result = parseReviewerOutput(reviewer, raw);
    expect(result.verdict.role).toBe("adversarial-reviewer");
    expect(result.verdict.model).toBe("gpt-5.3-codex");
    expect(result.verdict.verdict).toBe("pass");
  });
});

describe("formatGateComment", () => {
  it("formats a passing gate comment", () => {
    const results = [
      createResult({ verdict: "pass", role: "reviewer-1", feedback: "LGTM" }),
    ];
    const comment = formatGateComment("pass", results);
    expect(comment).toContain("Ensemble Review: PASS");
    expect(comment).toContain("reviewer-1");
    expect(comment).toContain("LGTM");
  });

  it("formats a failing gate comment with multiple reviewers", () => {
    const results = [
      createResult({ verdict: "pass", role: "reviewer-1", feedback: "OK" }),
      createResult({
        verdict: "fail",
        role: "security-reviewer",
        feedback: "Found XSS vulnerability",
      }),
    ];
    const comment = formatGateComment("fail", results);
    expect(comment).toContain("Ensemble Review: FAIL");
    expect(comment).toContain("reviewer-1");
    expect(comment).toContain("PASS");
    expect(comment).toContain("security-reviewer");
    expect(comment).toContain("FAIL");
    expect(comment).toContain("Found XSS vulnerability");
  });
});

describe("runEnsembleGate", () => {
  it("returns pass with empty comment when no reviewers configured", async () => {
    const result = await runEnsembleGate({
      issue: createIssue(),
      stage: createGateStage({ reviewers: [] }),
      createReviewerClient: () => {
        throw new Error("Should not be called");
      },
    });

    expect(result.aggregate).toBe("pass");
    expect(result.results).toHaveLength(0);
    expect(result.comment).toContain("No reviewers configured");
  });

  it("spawns reviewers in parallel and aggregates pass verdicts", async () => {
    const clientCalls: string[] = [];
    const result = await runEnsembleGate({
      issue: createIssue(),
      stage: createGateStage({
        reviewers: [
          {
            runner: "codex",
            model: "gpt-5.3-codex",
            role: "adversarial-reviewer",
            prompt: null,
          },
          {
            runner: "gemini",
            model: "gemini-3-pro",
            role: "security-reviewer",
            prompt: null,
          },
        ],
      }),
      createReviewerClient: (reviewer) => {
        clientCalls.push(reviewer.role);
        return createMockClient(
          `{"role": "${reviewer.role}", "model": "${reviewer.model}", "verdict": "pass"}\n\nLooks good.`,
        );
      },
    });

    expect(clientCalls).toContain("adversarial-reviewer");
    expect(clientCalls).toContain("security-reviewer");
    expect(result.aggregate).toBe("pass");
    expect(result.results).toHaveLength(2);
    expect(result.results.every((r) => r.verdict.verdict === "pass")).toBe(true);
  });

  it("aggregates to fail when one reviewer fails", async () => {
    const result = await runEnsembleGate({
      issue: createIssue(),
      stage: createGateStage({
        reviewers: [
          {
            runner: "codex",
            model: "gpt-5.3-codex",
            role: "adversarial-reviewer",
            prompt: null,
          },
          {
            runner: "gemini",
            model: "gemini-3-pro",
            role: "security-reviewer",
            prompt: null,
          },
        ],
      }),
      createReviewerClient: (reviewer) => {
        if (reviewer.role === "security-reviewer") {
          return createMockClient(
            `{"role": "security-reviewer", "model": "gemini-3-pro", "verdict": "fail"}\n\nSQL injection found.`,
          );
        }
        return createMockClient(
          `{"role": "adversarial-reviewer", "model": "gpt-5.3-codex", "verdict": "pass"}\n\nOK`,
        );
      },
    });

    expect(result.aggregate).toBe("fail");
    expect(result.results).toHaveLength(2);
  });

  it("treats reviewer infrastructure errors as error verdicts (not fail)", async () => {
    const result = await runEnsembleGate({
      issue: createIssue(),
      stage: createGateStage({
        reviewers: [
          {
            runner: "codex",
            model: "gpt-5.3-codex",
            role: "adversarial-reviewer",
            prompt: null,
          },
        ],
      }),
      createReviewerClient: () => createErrorClient("Connection timeout"),
      retryBaseDelayMs: 0,
    });

    // All reviewers errored → aggregate is fail (can't skip review)
    expect(result.aggregate).toBe("fail");
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.verdict.verdict).toBe("error");
    expect(result.results[0]!.feedback).toContain("Connection timeout");
  });

  it("passes gate when one reviewer passes and another errors", async () => {
    const result = await runEnsembleGate({
      issue: createIssue(),
      stage: createGateStage({
        reviewers: [
          {
            runner: "codex",
            model: "gpt-5.3-codex",
            role: "adversarial-reviewer",
            prompt: null,
          },
          {
            runner: "gemini",
            model: "gemini-2.5-pro",
            role: "security-reviewer",
            prompt: null,
          },
        ],
      }),
      createReviewerClient: (reviewer) => {
        if (reviewer.role === "security-reviewer") {
          return createErrorClient("Rate limit exceeded");
        }
        return createMockClient(
          `{"role": "adversarial-reviewer", "model": "gpt-5.3-codex", "verdict": "pass"}\n\nLooks good.`,
        );
      },
      retryBaseDelayMs: 0,
    });

    // One pass + one error = pass (error doesn't block)
    expect(result.aggregate).toBe("pass");
    expect(result.results).toHaveLength(2);
  });

  it("posts aggregated comment to tracker", async () => {
    const postedComments: Array<{ issueId: string; body: string }> = [];
    const postComment: PostComment = async (issueId, body) => {
      postedComments.push({ issueId, body });
    };

    await runEnsembleGate({
      issue: createIssue({ id: "issue-42" }),
      stage: createGateStage({
        reviewers: [
          {
            runner: "codex",
            model: "gpt-5.3-codex",
            role: "reviewer",
            prompt: null,
          },
        ],
      }),
      createReviewerClient: () =>
        createMockClient(
          '{"role": "reviewer", "model": "gpt-5.3-codex", "verdict": "pass"}\n\nLGTM',
        ),
      postComment,
    });

    expect(postedComments).toHaveLength(1);
    expect(postedComments[0]!.issueId).toBe("issue-42");
    expect(postedComments[0]!.body).toContain("Ensemble Review: PASS");
  });

  it("survives comment posting failure", async () => {
    const postComment: PostComment = async () => {
      throw new Error("Network error");
    };

    const result = await runEnsembleGate({
      issue: createIssue(),
      stage: createGateStage({
        reviewers: [
          {
            runner: "codex",
            model: "gpt-5.3-codex",
            role: "reviewer",
            prompt: null,
          },
        ],
      }),
      createReviewerClient: () =>
        createMockClient(
          '{"role": "reviewer", "model": "gpt-5.3-codex", "verdict": "pass"}\n\nOK',
        ),
      postComment,
    });

    // Should still succeed despite comment failure
    expect(result.aggregate).toBe("pass");
  });

  it("closes reviewer clients even on error", async () => {
    const closeCalls: string[] = [];
    const createClient: CreateReviewerClient = (reviewer) => ({
      startSession: async () => {
        throw new Error("boom");
      },
      continueTurn: async () => {
        throw new Error("not used");
      },
      close: async () => {
        closeCalls.push(reviewer.role);
      },
    });

    await runEnsembleGate({
      issue: createIssue(),
      stage: createGateStage({
        reviewers: [
          {
            runner: "codex",
            model: "m",
            role: "r1",
            prompt: null,
          },
          {
            runner: "gemini",
            model: "m",
            role: "r2",
            prompt: null,
          },
        ],
      }),
      createReviewerClient: createClient,
      retryBaseDelayMs: 0,
    });

    // With retries, close is called once per attempt per reviewer
    expect(closeCalls.filter(c => c === "r1").length).toBeGreaterThanOrEqual(1);
    expect(closeCalls.filter(c => c === "r2").length).toBeGreaterThanOrEqual(1);
  });
});

describe("ensemble gate orchestrator integration", () => {
  it("ensemble gate triggers approve and schedules continuation on pass", async () => {
    const { OrchestratorCore } = await import(
      "../../src/orchestrator/core.js"
    );

    const gateResults: EnsembleGateResult[] = [];
    const orchestrator = new OrchestratorCore({
      config: createConfig({
        stages: createEnsembleWorkflowConfig(),
      }),
      tracker: createTracker(),
      spawnWorker: async () => ({
        workerHandle: { pid: 1 },
        monitorHandle: { ref: "m" },
      }),
      runEnsembleGate: async ({ issue, stage }) => {
        const result: EnsembleGateResult = {
          aggregate: "pass",
          results: [],
          comment: "All clear",
        };
        gateResults.push(result);
        return result;
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    // Dispatch issue into "implement" (agent stage)
    await orchestrator.pollTick();
    expect(orchestrator.getState().issueStages["1"]).toBe("implement");

    // Normal exit advances to "review" (ensemble gate)
    orchestrator.onWorkerExit({ issueId: "1", outcome: "normal" });
    expect(orchestrator.getState().issueStages["1"]).toBe("review");

    // Retry timer dispatches gate — ensemble handler runs
    await orchestrator.onRetryTimer("1");

    // Wait for async gate handler to complete
    await vi.waitFor(() => {
      expect(gateResults).toHaveLength(1);
    });

    // Gate passed → approveGate called → issue should advance to "merge"
    await vi.waitFor(() => {
      expect(orchestrator.getState().issueStages["1"]).toBe("merge");
    });
  });

  it("ensemble gate triggers rework on fail", async () => {
    const { OrchestratorCore } = await import(
      "../../src/orchestrator/core.js"
    );

    const orchestrator = new OrchestratorCore({
      config: createConfig({
        stages: createEnsembleWorkflowConfig(),
      }),
      tracker: createTracker(),
      spawnWorker: async () => ({
        workerHandle: { pid: 1 },
        monitorHandle: { ref: "m" },
      }),
      runEnsembleGate: async () => ({
        aggregate: "fail" as const,
        results: [],
        comment: "Review failed",
      }),
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();
    orchestrator.onWorkerExit({ issueId: "1", outcome: "normal" });
    expect(orchestrator.getState().issueStages["1"]).toBe("review");

    await orchestrator.onRetryTimer("1");

    await vi.waitFor(() => {
      // Gate failed → reworkGate called → issue should go back to "implement"
      expect(orchestrator.getState().issueStages["1"]).toBe("implement");
    });

    expect(orchestrator.getState().issueReworkCounts["1"]).toBe(1);
  });

  it("human gate leaves issue in gate state without running handler", async () => {
    const { OrchestratorCore } = await import(
      "../../src/orchestrator/core.js"
    );

    const gateHandlerCalled = vi.fn();
    const orchestrator = new OrchestratorCore({
      config: createConfig({
        stages: createHumanGateWorkflowConfig(),
      }),
      tracker: createTracker(),
      spawnWorker: async () => ({
        workerHandle: { pid: 1 },
        monitorHandle: { ref: "m" },
      }),
      runEnsembleGate: async () => {
        gateHandlerCalled();
        return { aggregate: "pass" as const, results: [], comment: "" };
      },
      now: () => new Date("2026-03-06T00:00:05.000Z"),
    });

    await orchestrator.pollTick();
    orchestrator.onWorkerExit({ issueId: "1", outcome: "normal" });
    expect(orchestrator.getState().issueStages["1"]).toBe("review");

    // Retry timer — human gate should not run ensemble handler
    await orchestrator.onRetryTimer("1");

    // Give it a moment to ensure nothing fires
    await new Promise((r) => setTimeout(r, 50));

    expect(gateHandlerCalled).not.toHaveBeenCalled();
    // Issue stays in review (gate state)
    expect(orchestrator.getState().issueStages["1"]).toBe("review");
  });
});

describe("config resolver parses reviewers", () => {
  it("parses reviewers from stage config", async () => {
    const { resolveStagesConfig } = await import(
      "../../src/config/config-resolver.js"
    );

    const result = resolveStagesConfig({
      review: {
        type: "gate",
        gate_type: "ensemble",
        on_approve: "done",
        on_rework: "implement",
        max_rework: 3,
        reviewers: [
          {
            runner: "codex",
            model: "gpt-5.3-codex",
            role: "adversarial-reviewer",
            prompt: "review-adversarial.liquid",
          },
          {
            runner: "gemini",
            model: "gemini-3-pro",
            role: "security-reviewer",
            prompt: "review-security.liquid",
          },
        ],
      },
      implement: {
        type: "agent",
        on_complete: "review",
      },
      done: {
        type: "terminal",
      },
    });

    expect(result).not.toBeNull();
    const review = result!.stages.review!;
    expect(review.reviewers).toHaveLength(2);
    expect(review.reviewers[0]!.runner).toBe("codex");
    expect(review.reviewers[0]!.role).toBe("adversarial-reviewer");
    expect(review.reviewers[0]!.prompt).toBe("review-adversarial.liquid");
    expect(review.reviewers[1]!.runner).toBe("gemini");
    expect(review.reviewers[1]!.role).toBe("security-reviewer");
  });

  it("returns empty reviewers when not specified", async () => {
    const { resolveStagesConfig } = await import(
      "../../src/config/config-resolver.js"
    );

    const result = resolveStagesConfig({
      review: {
        type: "gate",
        gate_type: "ensemble",
        on_approve: "done",
      },
      done: {
        type: "terminal",
      },
    });

    expect(result!.stages.review!.reviewers).toEqual([]);
  });

  it("skips reviewers missing required runner or role", async () => {
    const { resolveStagesConfig } = await import(
      "../../src/config/config-resolver.js"
    );

    const result = resolveStagesConfig({
      review: {
        type: "gate",
        gate_type: "ensemble",
        on_approve: "done",
        reviewers: [
          { runner: "codex", role: "valid-reviewer" },
          { runner: "gemini" }, // missing role
          { role: "another-reviewer" }, // missing runner
          { model: "m" }, // missing both
        ],
      },
      done: {
        type: "terminal",
      },
    });

    expect(result!.stages.review!.reviewers).toHaveLength(1);
    expect(result!.stages.review!.reviewers[0]!.role).toBe("valid-reviewer");
  });
});

// --- Test Helpers ---

function createResult(overrides?: {
  verdict?: "pass" | "fail" | "error";
  role?: string;
  feedback?: string;
}): ReviewerResult {
  const verdict = overrides?.verdict ?? "pass";
  const role = overrides?.role ?? "test-reviewer";
  return {
    reviewer: {
      runner: "codex",
      model: "test-model",
      role,
      prompt: null,
    },
    verdict: {
      role,
      model: "test-model",
      verdict,
    },
    feedback: overrides?.feedback ?? "No issues found.",
    raw: "",
  };
}

function createMockClient(message: string): AgentRunnerCodexClient {
  return {
    startSession: async () => createTurnResult(message),
    continueTurn: async () => createTurnResult(message),
    close: async () => {},
  };
}

function createErrorClient(errorMessage: string): AgentRunnerCodexClient {
  return {
    startSession: async () => {
      throw new Error(errorMessage);
    },
    continueTurn: async () => {
      throw new Error(errorMessage);
    },
    close: async () => {},
  };
}

function createTurnResult(message: string): CodexTurnResult {
  return {
    status: "completed",
    threadId: "thread-1",
    turnId: "turn-1",
    sessionId: "session-1",
    usage: null,
    rateLimits: null,
    message,
  };
}

function createIssue(overrides?: Partial<Issue>): Issue {
  return {
    id: overrides?.id ?? "1",
    identifier: overrides?.identifier ?? "ISSUE-1",
    title: overrides?.title ?? "Example issue",
    description: overrides?.description ?? "Fix the bug in user auth",
    priority: overrides?.priority ?? 1,
    state: overrides?.state ?? "In Progress",
    branchName: overrides?.branchName ?? null,
    url: overrides?.url ?? "https://linear.app/project/issue/ISSUE-1",
    labels: overrides?.labels ?? [],
    blockedBy: overrides?.blockedBy ?? [],
    createdAt: overrides?.createdAt ?? "2026-03-01T00:00:00.000Z",
    updatedAt: overrides?.updatedAt ?? "2026-03-01T00:00:00.000Z",
  };
}

function createGateStage(overrides?: {
  reviewers?: ReviewerDefinition[];
}): StageDefinition {
  return {
    type: "gate",
    runner: null,
    model: null,
    prompt: null,
    maxTurns: null,
    timeoutMs: null,
    concurrency: null,
    gateType: "ensemble",
    maxRework: 3,
    reviewers: overrides?.reviewers ?? [],
    transitions: {
      onComplete: null,
      onApprove: "merge",
      onRework: "implement",
    },
  };
}

function createEnsembleWorkflowConfig() {
  return {
    initialStage: "implement",
    stages: {
      implement: {
        type: "agent" as const,
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
      },
      review: {
        type: "gate" as const,
        runner: null,
        model: null,
        prompt: null,
        maxTurns: null,
        timeoutMs: null,
        concurrency: null,
        gateType: "ensemble" as const,
        maxRework: 3,
        reviewers: [
          {
            runner: "codex",
            model: "gpt-5.3-codex",
            role: "adversarial-reviewer",
            prompt: null,
          },
        ],
        transitions: {
          onComplete: null,
          onApprove: "merge",
          onRework: "implement",
        },
      },
      merge: {
        type: "agent" as const,
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
      },
      done: {
        type: "terminal" as const,
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
      },
    },
  };
}

function createHumanGateWorkflowConfig() {
  const config = createEnsembleWorkflowConfig();
  return {
    ...config,
    stages: {
      ...config.stages,
      review: {
        ...config.stages.review,
        gateType: "human" as const,
        reviewers: [],
      },
    },
  };
}

function createTracker() {
  const issue = createIssue();
  return {
    async fetchCandidateIssues() {
      return [issue];
    },
    async fetchIssuesByStates() {
      return [];
    },
    async fetchIssueStatesByIds() {
      return [{ id: issue.id, identifier: issue.identifier, state: issue.state }];
    },
  };
}

function createConfig(overrides?: { stages?: ReturnType<typeof createEnsembleWorkflowConfig> | ReturnType<typeof createHumanGateWorkflowConfig> | null }) {
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
    polling: { intervalMs: 30_000 },
    workspace: { root: "/tmp/workspaces" },
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
      maxConcurrentAgentsByState: {},
    },
    runner: { kind: "codex", model: null },
    codex: {
      command: "codex-app-server",
      approvalPolicy: "never",
      threadSandbox: null,
      turnSandboxPolicy: null,
      turnTimeoutMs: 300_000,
      readTimeoutMs: 30_000,
      stallTimeoutMs: 300_000,
    },
    server: { port: null },
    observability: {
      dashboardEnabled: true,
      refreshMs: 1_000,
      renderIntervalMs: 16,
    },
    stages: overrides?.stages ?? null,
  };
}
