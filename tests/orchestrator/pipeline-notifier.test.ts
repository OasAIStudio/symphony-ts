import { describe, expect, it, vi } from "vitest";

import {
  PipelineNotifier,
  formatDurationMs,
  formatNotification,
  formatStageTimeline,
} from "../../src/orchestrator/pipeline-notifier.js";
import type {
  NotificationPoster,
  PipelineNotificationEvent,
} from "../../src/orchestrator/pipeline-notifier.js";

describe("formatDurationMs", () => {
  it("formats seconds only", () => {
    expect(formatDurationMs(45_000)).toBe("45s");
  });

  it("formats minutes and seconds", () => {
    expect(formatDurationMs(125_000)).toBe("2m 5s");
  });

  it("formats exact minutes without seconds", () => {
    expect(formatDurationMs(180_000)).toBe("3m");
  });

  it("formats hours and minutes", () => {
    expect(formatDurationMs(3_720_000)).toBe("1h 2m");
  });

  it("formats exact hours without minutes", () => {
    expect(formatDurationMs(7_200_000)).toBe("2h");
  });

  it("rounds sub-second durations to zero", () => {
    expect(formatDurationMs(499)).toBe("0s");
  });
});

describe("formatStageTimeline", () => {
  it("returns placeholder for empty history", () => {
    expect(formatStageTimeline([])).toBe("_No stage data_");
  });

  it("formats a single stage record", () => {
    const result = formatStageTimeline([
      {
        stageName: "investigate",
        durationMs: 90_000,
        totalTokens: 12345,
        turns: 3,
        outcome: "completed",
      },
    ]);
    expect(result).toContain("investigate");
    expect(result).toContain("1m 30s");
    expect(result).toContain("12,345 tokens");
    expect(result).toContain("completed");
  });

  it("formats multiple stages on separate lines", () => {
    const result = formatStageTimeline([
      {
        stageName: "investigate",
        durationMs: 60_000,
        totalTokens: 5000,
        turns: 2,
        outcome: "completed",
      },
      {
        stageName: "implement",
        durationMs: 120_000,
        totalTokens: 15000,
        turns: 5,
        outcome: "completed",
      },
    ]);
    const lines = result.split("\n");
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain("investigate");
    expect(lines[1]).toContain("implement");
  });
});

describe("formatNotification", () => {
  it("formats pipeline_started", () => {
    const text = formatNotification({
      type: "pipeline_started",
      productName: "symphony",
      dashboardUrl: "http://localhost:3000",
    });
    expect(text).toContain("Pipeline started");
    expect(text).toContain("symphony");
    expect(text).toContain("http://localhost:3000");
  });

  it("formats pipeline_started without dashboard url", () => {
    const text = formatNotification({
      type: "pipeline_started",
      productName: "symphony",
      dashboardUrl: null,
    });
    expect(text).toContain("Pipeline started");
    expect(text).not.toContain("Dashboard");
  });

  it("formats pipeline_stopped", () => {
    const text = formatNotification({
      type: "pipeline_stopped",
      productName: "symphony",
      completedCount: 5,
      failedCount: 2,
      durationMs: 3_600_000,
    });
    expect(text).toContain("Pipeline stopped");
    expect(text).toContain("Completed: 5");
    expect(text).toContain("Failed: 2");
    expect(text).toContain("Total: 7");
    expect(text).toContain("1h");
  });

  it("formats issue_completed", () => {
    const text = formatNotification({
      type: "issue_completed",
      issueIdentifier: "SYMPH-42",
      issueTitle: "Add pagination",
      issueUrl: "https://linear.app/mobilyze-llc/issue/SYMPH-42",
      executionHistory: [
        {
          stageName: "investigate",
          durationMs: 60_000,
          totalTokens: 5000,
          turns: 2,
          outcome: "completed",
        },
        {
          stageName: "implement",
          durationMs: 120_000,
          totalTokens: 15000,
          turns: 5,
          outcome: "completed",
        },
      ],
      reworkCount: 1,
      totalTokens: 20000,
      totalDurationMs: 180_000,
    });
    expect(text).toContain("Issue completed");
    expect(text).toContain("SYMPH-42");
    expect(text).toContain("Add pagination");
    expect(text).toContain("investigate");
    expect(text).toContain("implement");
    expect(text).toContain("20,000 tokens");
    expect(text).toContain("Rework cycles: 1");
  });

  it("formats issue_completed without rework", () => {
    const text = formatNotification({
      type: "issue_completed",
      issueIdentifier: "SYMPH-42",
      issueTitle: "Add pagination",
      issueUrl: null,
      executionHistory: [],
      reworkCount: 0,
      totalTokens: 10000,
      totalDurationMs: 60_000,
    });
    expect(text).not.toContain("Rework");
  });

  it("formats issue_failed", () => {
    const text = formatNotification({
      type: "issue_failed",
      issueIdentifier: "SYMPH-42",
      issueTitle: "Add pagination",
      issueUrl: "https://linear.app/mobilyze-llc/issue/SYMPH-42",
      failureReason: "Max retries exceeded",
      retriesExhausted: true,
      retryAttempt: 3,
    });
    expect(text).toContain("Issue failed");
    expect(text).toContain("SYMPH-42");
    expect(text).toContain("Max retries exceeded");
    expect(text).toContain("Retries exhausted (attempt 3)");
  });

  it("formats issue_failed without exhaustion", () => {
    const text = formatNotification({
      type: "issue_failed",
      issueIdentifier: "SYMPH-42",
      issueTitle: "Fix bug",
      issueUrl: null,
      failureReason: "worker failed",
      retriesExhausted: false,
      retryAttempt: null,
    });
    expect(text).toContain("Issue failed");
    expect(text).not.toContain("Retries exhausted");
  });

  it("formats stall_killed", () => {
    const text = formatNotification({
      type: "stall_killed",
      issueIdentifier: "SYMPH-42",
      issueTitle: "Add pagination",
      stageName: "implement",
      stallDurationMs: 900_000,
    });
    expect(text).toContain("Stall killed");
    expect(text).toContain("SYMPH-42");
    expect(text).toContain("Stage: implement");
    expect(text).toContain("15m");
  });

  it("formats stall_killed without stage name", () => {
    const text = formatNotification({
      type: "stall_killed",
      issueIdentifier: "SYMPH-42",
      issueTitle: "Fix bug",
      stageName: null,
      stallDurationMs: 300_000,
    });
    expect(text).not.toContain("Stage:");
  });

  it("formats infra_error", () => {
    const text = formatNotification({
      type: "infra_error",
      issueIdentifier: "SYMPH-42",
      issueTitle: "Add pagination",
      errorReason: "Failed to start agent process",
    });
    expect(text).toContain("Infra error");
    expect(text).toContain("SYMPH-42");
    expect(text).toContain("Failed to start agent process");
  });
});

describe("PipelineNotifier", () => {
  function createMockPoster(): NotificationPoster & {
    calls: Array<{ channel: string; text: string }>;
  } {
    const calls: Array<{ channel: string; text: string }> = [];
    return {
      calls,
      async post(channel: string, text: string): Promise<void> {
        calls.push({ channel, text });
      },
    };
  }

  it("posts formatted notification to configured channel", async () => {
    const poster = createMockPoster();
    const notifier = new PipelineNotifier({
      channel: "C12345",
      poster,
    });

    notifier.notify({
      type: "pipeline_started",
      productName: "symphony",
      dashboardUrl: null,
    });

    // Wait for the async post
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(poster.calls).toHaveLength(1);
    expect(poster.calls[0]?.channel).toBe("C12345");
    expect(poster.calls[0]?.text).toContain("Pipeline started");
  });

  it("swallows errors and calls onError callback", async () => {
    const errors: unknown[] = [];
    const failingPoster: NotificationPoster = {
      async post(): Promise<void> {
        throw new Error("Slack API down");
      },
    };
    const notifier = new PipelineNotifier({
      channel: "C12345",
      poster: failingPoster,
      onError: (err) => errors.push(err),
    });

    notifier.notify({
      type: "pipeline_started",
      productName: "symphony",
      dashboardUrl: null,
    });

    // Wait for the async rejection
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(Error);
    expect((errors[0] as Error).message).toBe("Slack API down");
  });

  it("swallows errors silently when no onError callback provided", async () => {
    const failingPoster: NotificationPoster = {
      async post(): Promise<void> {
        throw new Error("Slack API down");
      },
    };
    const notifier = new PipelineNotifier({
      channel: "C12345",
      poster: failingPoster,
    });

    // Should not throw
    notifier.notify({
      type: "pipeline_started",
      productName: "symphony",
      dashboardUrl: null,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));
  });

  it("sends multiple events to the same channel", async () => {
    const poster = createMockPoster();
    const notifier = new PipelineNotifier({
      channel: "C12345",
      poster,
    });

    const events: PipelineNotificationEvent[] = [
      { type: "pipeline_started", productName: "test", dashboardUrl: null },
      {
        type: "issue_completed",
        issueIdentifier: "TEST-1",
        issueTitle: "Test",
        issueUrl: null,
        executionHistory: [],
        reworkCount: 0,
        totalTokens: 100,
        totalDurationMs: 1000,
      },
      {
        type: "pipeline_stopped",
        productName: "test",
        completedCount: 1,
        failedCount: 0,
        durationMs: 5000,
      },
    ];

    for (const event of events) {
      notifier.notify(event);
    }

    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(poster.calls).toHaveLength(3);
    expect(poster.calls.every((c) => c.channel === "C12345")).toBe(true);
  });
});
