import { execFileSync } from "node:child_process";

import type { AgentRunnerCodexClient } from "../agent/runner.js";
import type { CodexTurnResult } from "../codex/app-server-client.js";
import type { ReviewerDefinition, StageDefinition } from "../config/types.js";
import type { Issue } from "../domain/model.js";

/**
 * Single reviewer verdict — the minimal JSON layer of the two-layer output.
 * "error" means the reviewer failed to execute (rate limit, network, etc.)
 * and should not count as a code review failure.
 */
export interface ReviewerVerdict {
  role: string;
  model: string;
  verdict: "pass" | "fail" | "error";
}

/**
 * Full result from a single reviewer: verdict JSON + plain text feedback.
 */
export interface ReviewerResult {
  reviewer: ReviewerDefinition;
  verdict: ReviewerVerdict;
  feedback: string;
  raw: string;
}

/**
 * Aggregate result from all reviewers.
 */
export type AggregateVerdict = "pass" | "fail";

export interface EnsembleGateResult {
  aggregate: AggregateVerdict;
  results: ReviewerResult[];
  comment: string;
}

/**
 * Factory function type for creating a runner client for a reviewer.
 */
export type CreateReviewerClient = (reviewer: ReviewerDefinition) => AgentRunnerCodexClient;

/**
 * Function type for posting a comment to an issue tracker.
 */
export type PostComment = (issueId: string, body: string) => Promise<void>;

export interface EnsembleGateHandlerOptions {
  issue: Issue;
  stage: StageDefinition;
  createReviewerClient: CreateReviewerClient;
  postComment?: PostComment;
  workspacePath?: string;
  /** Override retry base delay (ms) for testing. Default: 5000. */
  retryBaseDelayMs?: number;
}

/**
 * Run the ensemble gate: spawn N reviewers in parallel, aggregate verdicts.
 */
export async function runEnsembleGate(
  options: EnsembleGateHandlerOptions,
): Promise<EnsembleGateResult> {
  const { issue, stage, createReviewerClient, postComment, workspacePath } = options;
  const reviewers = stage.reviewers;

  if (reviewers.length === 0) {
    return {
      aggregate: "pass",
      results: [],
      comment: "No reviewers configured — auto-passing gate.",
    };
  }

  const diff = workspacePath ? getDiff(workspacePath) : null;
  const retryBaseDelayMs = options.retryBaseDelayMs ?? REVIEWER_RETRY_BASE_DELAY_MS;

  const results = await Promise.all(
    reviewers.map((reviewer) =>
      runSingleReviewer(reviewer, issue, createReviewerClient, diff, retryBaseDelayMs),
    ),
  );

  const aggregate = aggregateVerdicts(results);
  const comment = formatGateComment(aggregate, results);

  if (postComment !== undefined) {
    try {
      await postComment(issue.id, comment);
    } catch {
      // Comment posting is best-effort — don't fail the gate on it.
    }
  }

  return { aggregate, results, comment };
}

/**
 * Aggregate individual verdicts.
 * - Any explicit "fail" verdict (from a reviewer that actually ran) = FAIL.
 * - If ALL reviewers errored (no pass or fail verdicts), = FAIL (can't skip review).
 * - Otherwise (all pass/error with at least one pass) = PASS.
 */
export function aggregateVerdicts(results: ReviewerResult[]): AggregateVerdict {
  if (results.length === 0) {
    return "pass";
  }

  const hasExplicitFail = results.some((r) => r.verdict.verdict === "fail");
  if (hasExplicitFail) {
    return "fail";
  }

  const hasAnyNonError = results.some((r) => r.verdict.verdict !== "error");
  if (!hasAnyNonError) {
    // All reviewers errored — can't skip review entirely
    return "fail";
  }

  return "pass";
}

/**
 * Maximum number of retry attempts for transient reviewer errors
 * (rate limits, network timeouts, etc.)
 */
export const MAX_REVIEWER_RETRIES = 3;

/**
 * Delay between retry attempts in ms (doubles each attempt).
 */
export const REVIEWER_RETRY_BASE_DELAY_MS = 5_000;

/**
 * Run a single reviewer with retries for transient errors.
 * Infrastructure failures (rate limits, network) are retried up to MAX_REVIEWER_RETRIES times.
 * If all retries fail, returns an "error" verdict instead of "fail" so it doesn't
 * block the gate on infrastructure issues.
 */
async function runSingleReviewer(
  reviewer: ReviewerDefinition,
  issue: Issue,
  createReviewerClient: CreateReviewerClient,
  diff: string | null,
  retryBaseDelayMs: number = REVIEWER_RETRY_BASE_DELAY_MS,
): Promise<ReviewerResult> {
  const prompt = buildReviewerPrompt(reviewer, issue, diff);
  const title = `Review: ${issue.identifier} (${reviewer.role})`;
  let lastError = "";

  for (let attempt = 0; attempt <= MAX_REVIEWER_RETRIES; attempt++) {
    const client = createReviewerClient(reviewer);
    try {
      const result: CodexTurnResult = await client.startSession({ prompt, title });
      const raw = result.message ?? "";
      return parseReviewerOutput(reviewer, raw);
    } catch (error) {
      lastError =
        error instanceof Error ? error.message : "Reviewer process failed";
      // Close client before retry
      try { await client.close(); } catch { /* best-effort */ }

      if (attempt < MAX_REVIEWER_RETRIES) {
        const delay = retryBaseDelayMs * Math.pow(2, attempt);
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
    } finally {
      try {
        await client.close();
      } catch {
        // Best-effort cleanup.
      }
    }
  }

  // All retries exhausted — infrastructure failure, not a code review failure.
  return {
    reviewer,
    verdict: {
      role: reviewer.role,
      model: reviewer.model ?? "unknown",
      verdict: "error",
    },
    feedback: `Failed after ${MAX_REVIEWER_RETRIES + 1} attempts. Last error: ${lastError}`,
    raw: "",
  };
}

/**
 * Fetch the git diff for the workspace (origin/main...HEAD).
 * Returns the diff string, truncated to maxChars. Returns empty string on failure.
 */
const MAX_DIFF_CHARS = 12_000;

export function getDiff(workspacePath: string, maxChars = MAX_DIFF_CHARS): string {
  try {
    const raw = execFileSync("git", ["diff", "origin/main...HEAD"], {
      cwd: workspacePath,
      encoding: "utf-8",
      maxBuffer: 2 * 1024 * 1024,
      timeout: 15_000,
    });
    if (raw.length <= maxChars) {
      return raw;
    }
    return raw.slice(0, maxChars) + "\n\n... (diff truncated)";
  } catch {
    return "";
  }
}

/**
 * Build the prompt for a reviewer. Includes issue metadata, role context,
 * the actual PR diff, and the reviewer's prompt field as inline instructions.
 */
function buildReviewerPrompt(
  reviewer: ReviewerDefinition,
  issue: Issue,
  diff: string | null,
): string {
  const lines = [
    `You are a code reviewer with the role: ${reviewer.role}.`,
    "",
    `## Issue`,
    `- Identifier: ${issue.identifier}`,
    `- Title: ${issue.title}`,
    ...(issue.description ? [`- Description: ${issue.description}`] : []),
    ...(issue.url ? [`- URL: ${issue.url}`] : []),
  ];

  if (diff && diff.length > 0) {
    lines.push(
      "",
      `## Code Changes (git diff)`,
      "```diff",
      diff,
      "```",
    );
  }

  if (reviewer.prompt) {
    lines.push("", `## Review Focus`, reviewer.prompt);
  }

  lines.push(
    "",
    `## Instructions`,
    `Review the code changes above for this issue. Respond with TWO sections:`,
    "",
    `1. A JSON verdict line (must be valid JSON on a single line):`,
    "```",
    `{"role": "${reviewer.role}", "model": "${reviewer.model ?? "unknown"}", "verdict": "pass"}`,
    "```",
    `Set verdict to "pass" if the changes look good, or "fail" if there are issues.`,
    "",
    `2. Plain text feedback explaining your assessment.`,
  );

  return lines.join("\n");
}

/**
 * Parse reviewer output into verdict JSON + feedback text.
 * Expects the output to contain a JSON line with {role, model, verdict}
 * followed by plain text feedback.
 */
export function parseReviewerOutput(
  reviewer: ReviewerDefinition,
  raw: string,
): ReviewerResult {
  const defaultVerdict: ReviewerVerdict = {
    role: reviewer.role,
    model: reviewer.model ?? "unknown",
    verdict: "fail",
  };

  if (raw.trim().length === 0) {
    return {
      reviewer,
      verdict: defaultVerdict,
      feedback: "Reviewer returned empty output — treating as fail.",
      raw,
    };
  }

  // Try to find a JSON verdict in the output
  const verdictMatch = raw.match(/\{[^}]*"verdict"\s*:\s*"(?:pass|fail)"[^}]*\}/);
  if (verdictMatch === null) {
    return {
      reviewer,
      verdict: defaultVerdict,
      feedback: raw.trim(),
      raw,
    };
  }

  try {
    const parsed = JSON.parse(verdictMatch[0]) as Record<string, unknown>;
    const verdict: ReviewerVerdict = {
      role: typeof parsed.role === "string" ? parsed.role : reviewer.role,
      model:
        typeof parsed.model === "string"
          ? parsed.model
          : reviewer.model ?? "unknown",
      verdict: parsed.verdict === "pass" ? "pass" : "fail",
    };

    // Feedback is everything except the JSON line
    const feedback = raw
      .replace(verdictMatch[0], "")
      .replace(/```/g, "")
      .trim();

    return {
      reviewer,
      verdict,
      feedback: feedback.length > 0 ? feedback : "No additional feedback.",
      raw,
    };
  } catch {
    return {
      reviewer,
      verdict: defaultVerdict,
      feedback: raw.trim(),
      raw,
    };
  }
}

/**
 * Format the aggregate gate result as a markdown comment for Linear.
 */
export function formatGateComment(
  aggregate: AggregateVerdict,
  results: ReviewerResult[],
): string {
  const header =
    aggregate === "pass"
      ? "## Ensemble Review: PASS"
      : "## Ensemble Review: FAIL";

  const sections = results.map((r) => {
    const iconMap = { pass: "PASS", fail: "FAIL", error: "ERROR" } as const;
    const icon = iconMap[r.verdict.verdict] ?? "FAIL";
    return [
      `### ${r.verdict.role} (${r.verdict.model}): ${icon}`,
      "",
      r.feedback,
    ].join("\n");
  });

  return [header, "", ...sections].join("\n");
}
