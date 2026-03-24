import { describe, expect, it } from "vitest";

import type { RuntimeSnapshot } from "../../src/logging/runtime-snapshot.js";
import { renderDashboardHtml } from "../../src/observability/dashboard-render.js";
import { getDisplayVersion } from "../../src/version.js";

const BASE_ROW: RuntimeSnapshot["running"][number] = {
  issue_id: "issue-1",
  issue_identifier: "SYMPH-47",
  issue_title: "Test issue title",
  state: "In Progress",
  pipeline_stage: "implement",
  activity_summary: "Working on it",
  session_id: "session-abc",
  turn_count: 3,
  last_event: "notification",
  last_message: "Working on it",
  started_at: "2026-03-21T10:00:00.000Z",
  first_dispatched_at: "2026-03-21T10:00:00.000Z",
  last_event_at: "2026-03-21T10:01:00.000Z",
  stage_duration_seconds: 60,
  tokens_per_turn: 500,
  tokens: {
    input_tokens: 1000,
    output_tokens: 500,
    total_tokens: 1500,
    cache_read_tokens: 200,
    cache_write_tokens: 100,
    reasoning_tokens: 50,
  },
  total_pipeline_tokens: 1500,
  execution_history: [],
  turn_history: [],
  recent_activity: [],
  health: "green",
  health_reason: null,
};

function buildSnapshot(
  rowOverrides: Partial<RuntimeSnapshot["running"][number]>,
): RuntimeSnapshot {
  return {
    generated_at: "2026-03-21T10:05:30.000Z",
    counts: { running: 1, retrying: 0, completed: 0, failed: 0 },
    running: [{ ...BASE_ROW, ...rowOverrides }],
    retrying: [],
    codex_totals: {
      input_tokens: 1000,
      output_tokens: 500,
      total_tokens: 1500,
      seconds_running: 330,
    },
    rate_limits: {},
  };
}

describe("Dashboard Pipeline column", () => {
  it("shows 'Pipeline' column header in the running table", () => {
    const snapshot = buildSnapshot({});
    const html = renderDashboardHtml(snapshot, { liveUpdatesEnabled: false });
    expect(html).toContain("<th>Pipeline</th>");
  });

  it("shows elapsed pipeline time for multi-stage issues (first_dispatched_at earlier than started_at)", () => {
    // first_dispatched_at is 5m 30s before started_at
    // generated_at is 2026-03-21T10:05:30.000Z
    // first_dispatched_at is 2026-03-21T09:54:30.000Z → 11m 0s before generated_at
    const snapshot = buildSnapshot({
      started_at: "2026-03-21T10:00:00.000Z",
      first_dispatched_at: "2026-03-21T09:54:30.000Z",
    });
    const html = renderDashboardHtml(snapshot, { liveUpdatesEnabled: false });
    // Pipeline time: from 09:54:30 to 10:05:30 = 11m 0s
    expect(html).toContain("11m 0s");
  });

  it("shows '—' in the Pipeline column for single-stage issues (first_dispatched_at equals started_at)", () => {
    const snapshot = buildSnapshot({
      started_at: "2026-03-21T10:00:00.000Z",
      first_dispatched_at: "2026-03-21T10:00:00.000Z",
    });
    const html = renderDashboardHtml(snapshot, { liveUpdatesEnabled: false });
    // The Pipeline td should contain an em-dash (—)
    // Use a regex to check the Pipeline column td contains — and no time string pattern near it
    expect(html).toContain("—");
    // Verify: the Pipeline cell itself does NOT contain a "Xm Ys" pattern
    // We do this by checking the generated HTML around the runtime column
    // The runtime/turns column shows time since started_at; Pipeline should be —
    const pipelineCellMatch = html.match(
      /<td class="numeric">[^<]*<\/td>\s*<td class="numeric">([^<]*)<\/td>/,
    );
    expect(pipelineCellMatch).not.toBeNull();
    const pipelineContent: string | undefined = pipelineCellMatch?.[1];
    // The second numeric cell (Pipeline) should be —
    expect(pipelineContent?.trim()).toBe("—");
  });

  it("includes formatPipelineTime in client-side JavaScript", () => {
    const snapshot = buildSnapshot({});
    const html = renderDashboardHtml(snapshot, { liveUpdatesEnabled: true });
    expect(html).toContain("formatPipelineTime");
  });
  it("dashboard shows version in hero header", () => {
    const snapshot = buildSnapshot({});
    const html = renderDashboardHtml(snapshot, { liveUpdatesEnabled: false });
    expect(html).toContain(getDisplayVersion());
    expect(html).toContain("Symphony Observability");
  });
});
