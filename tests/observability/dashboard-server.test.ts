import { type IncomingMessage, request as httpRequest } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeSnapshot } from "../../src/logging/runtime-snapshot.js";
import {
  type DashboardServerHost,
  type IssueDetailResponse,
  type RefreshResponse,
  createDashboardServer,
  startDashboardServer,
} from "../../src/observability/dashboard-server.js";

describe("dashboard server", () => {
  const servers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  it("serves the html dashboard and json state snapshot", async () => {
    const server = await startDashboardServer({
      port: 0,
      host: createHost(),
    });
    servers.push(server);

    expect(server.hostname).toBe("0.0.0.0");
    expect(server.port).toBeGreaterThan(0);

    const dashboard = await sendRequest(server.port, {
      method: "GET",
      path: "/",
    });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.headers["content-type"]).toContain("text/html");
    expect(dashboard.body).toContain("Operations Dashboard");
    expect(dashboard.body).toContain("ABC-123");
    expect(dashboard.body).toContain("Running sessions");
    expect(dashboard.body).toContain("Runtime / turns");
    expect(dashboard.body).toContain("Codex update");
    expect(dashboard.body).toContain("Copy ID");
    expect(dashboard.body).toContain("state-badge");
    expect(dashboard.body).toContain("window.__SYMPHONY_SNAPSHOT__");
    expect(dashboard.body).toContain("/api/v1/events");

    const state = await sendRequest(server.port, {
      method: "GET",
      path: "/api/v1/state",
    });
    expect(state.statusCode).toBe(200);
    expect(state.headers["content-type"]).toContain("application/json");
    expect(JSON.parse(state.body)).toMatchObject({
      counts: {
        running: 1,
        retrying: 1,
      },
      running: [{ issue_identifier: "ABC-123" }],
    });
  });

  it("stops serving requests after the listener is closed", async () => {
    const server = await startDashboardServer({
      port: 0,
      host: createHost(),
    });

    const first = await sendRequest(server.port, {
      method: "GET",
      path: "/api/v1/state",
    });
    expect(first.statusCode).toBe(200);

    await server.close();

    await expect(
      sendRequest(server.port, {
        method: "GET",
        path: "/api/v1/state",
      }),
    ).rejects.toThrow();
  });

  it("returns issue details and a 404 json error for unknown issues", async () => {
    const server = await startDashboardServer({
      port: 0,
      host: createHost(),
    });
    servers.push(server);

    const issue = await sendRequest(server.port, {
      method: "GET",
      path: "/api/v1/ABC-123",
    });
    expect(issue.statusCode).toBe(200);
    expect(JSON.parse(issue.body)).toMatchObject({
      issue_identifier: "ABC-123",
      status: "running",
      workspace: {
        path: "/tmp/symphony/ABC-123",
      },
    });

    const missing = await sendRequest(server.port, {
      method: "GET",
      path: "/api/v1/UNKNOWN-1",
    });
    expect(missing.statusCode).toBe(404);
    expect(JSON.parse(missing.body)).toEqual({
      error: {
        code: "issue_not_found",
        message:
          "Issue 'UNKNOWN-1' is not tracked in the current runtime state.",
      },
    });
  });

  it("accepts refresh requests and rejects unsupported methods with 405", async () => {
    const refreshCalls: RefreshResponse[] = [];
    const server = await startDashboardServer({
      port: 0,
      host: createHost({
        requestRefresh: () => {
          const response = {
            queued: true,
            coalesced: false,
            requested_at: "2026-03-06T12:00:00.000Z",
            operations: ["poll", "reconcile"],
          } satisfies RefreshResponse;
          refreshCalls.push(response);
          return response;
        },
      }),
    });
    servers.push(server);

    const refresh = await sendRequest(server.port, {
      method: "POST",
      path: "/api/v1/refresh",
      body: "{}",
      headers: {
        "content-type": "application/json",
      },
    });
    expect(refresh.statusCode).toBe(202);
    expect(JSON.parse(refresh.body)).toEqual({
      queued: true,
      coalesced: false,
      requested_at: "2026-03-06T12:00:00.000Z",
      operations: ["poll", "reconcile"],
    });
    expect(refreshCalls).toHaveLength(1);

    const invalidMethod = await sendRequest(server.port, {
      method: "POST",
      path: "/api/v1/state",
    });
    expect(invalidMethod.statusCode).toBe(405);
    expect(invalidMethod.headers.allow).toBe("GET");
    expect(JSON.parse(invalidMethod.body)).toEqual({
      error: {
        code: "method_not_allowed",
        message: "Method not allowed.",
      },
    });

    const invalidRefreshMethod = await sendRequest(server.port, {
      method: "GET",
      path: "/api/v1/refresh",
    });
    expect(invalidRefreshMethod.statusCode).toBe(405);
    expect(invalidRefreshMethod.headers.allow).toBe("POST");

    const invalidRootMethod = await sendRequest(server.port, {
      method: "POST",
      path: "/",
    });
    expect(invalidRootMethod.statusCode).toBe(405);
    expect(invalidRootMethod.headers.allow).toBe("GET");
  });

  it("returns snapshot_unavailable when the host snapshot fails", async () => {
    const server = createDashboardServer({
      host: createHost({
        getRuntimeSnapshot: () => {
          throw new Error("snapshot exploded");
        },
      }),
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("expected TCP server address");
    }
    servers.push({
      close: async () => {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }
            resolve();
          });
        });
      },
    });

    const response = await sendRequest(address.port, {
      method: "GET",
      path: "/api/v1/state",
    });
    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body)).toEqual({
      error: {
        code: "snapshot_unavailable",
        message: "snapshot exploded",
      },
    });
  });

  it("returns snapshot_timed_out when the host snapshot stalls", async () => {
    const server = await startDashboardServer({
      port: 0,
      snapshotTimeoutMs: 25,
      host: createHost({
        getRuntimeSnapshot: async () =>
          await new Promise<RuntimeSnapshot>(() => undefined),
      }),
    });
    servers.push(server);

    const response = await sendRequest(server.port, {
      method: "GET",
      path: "/api/v1/state",
    });
    expect(response.statusCode).toBe(504);
    expect(JSON.parse(response.body)).toEqual({
      error: {
        code: "snapshot_timed_out",
        message: "Runtime snapshot timed out after 25ms.",
      },
    });
  });

  it("streams snapshot updates over server-sent events", async () => {
    let snapshot = createSnapshot();
    let emitUpdate = () => {};
    const server = await startDashboardServer({
      port: 0,
      renderIntervalMs: 5,
      host: createHost({
        getRuntimeSnapshot: () => snapshot,
        subscribeToSnapshots: (listener) => {
          emitUpdate = listener;
          return () => {
            emitUpdate = () => {};
          };
        },
      }),
    });
    servers.push(server);

    const stream = await openEventStream(server.port, "/api/v1/events");
    const initial = await stream.nextEvent();
    expect(initial.event).toBe("snapshot");
    expect(JSON.parse(initial.data)).toMatchObject({
      generated_at: "2026-03-06T10:00:00.000Z",
      counts: {
        running: 1,
      },
    });

    snapshot = {
      ...snapshot,
      generated_at: "2026-03-06T10:00:02.000Z",
      counts: {
        running: 2,
        retrying: 1,
        completed: 0,
        failed: 0,
      },
    };
    emitUpdate();

    const next = await stream.nextEvent();
    expect(next.event).toBe("snapshot");
    expect(JSON.parse(next.data)).toMatchObject({
      generated_at: "2026-03-06T10:00:02.000Z",
      counts: {
        running: 2,
      },
    });

    stream.close();
  });

  it("renders expandable detail rows with toggle and detail panel for running sessions", async () => {
    const server = await startDashboardServer({
      port: 0,
      host: createHost(),
    });
    servers.push(server);

    const dashboard = await sendRequest(server.port, {
      method: "GET",
      path: "/",
    });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.body).toContain("expand-toggle");
    expect(dashboard.body).toContain("detail-row");
    expect(dashboard.body).toContain("detail-panel");
    expect(dashboard.body).toContain("detail-grid");
    expect(dashboard.body).toContain("Token breakdown");
    expect(dashboard.body).toContain("Recent activity");
    expect(dashboard.body).toContain("Execution history");
    expect(dashboard.body).toContain("aria-expanded");
    expect(dashboard.body).toContain("Cache read");
    expect(dashboard.body).toContain("Cache write");
    expect(dashboard.body).toContain("Reasoning");
  });

  it("renders context section in detail panel with stage, activity summary, health reason, and rework count", async () => {
    const baseRow = createSnapshot().running[0]!;
    const snapshotWithContext: RuntimeSnapshot = {
      ...createSnapshot(),
      running: [
        {
          ...baseRow,
          pipeline_stage: "implement",
          activity_summary: "Reviewing PR #42",
          health: "yellow",
          health_reason: "high token burn: 23,400 tokens/turn",
          rework_count: 2,
        },
      ],
    };
    const server = await startDashboardServer({
      port: 0,
      host: createHost({
        getRuntimeSnapshot: () => snapshotWithContext,
      }),
    });
    servers.push(server);

    const dashboard = await sendRequest(server.port, {
      method: "GET",
      path: "/",
    });
    expect(dashboard.statusCode).toBe(200);
    // Use class= attribute form since CSS also defines these class names
    expect(dashboard.body).toContain('class="context-section"');
    expect(dashboard.body).toContain('class="stage-badge"');
    expect(dashboard.body).toContain("implement");
    expect(dashboard.body).toContain("Reviewing PR #42");
    expect(dashboard.body).toContain('class="context-health-yellow"');
    expect(dashboard.body).toContain("high token burn: 23,400 tokens/turn");
    expect(dashboard.body).toContain("state-badge-warning");
    expect(dashboard.body).toContain("Rework");
    // Context section (rendered element) appears before detail-grid in the HTML
    const contextIdx = dashboard.body.indexOf('class="context-section"');
    const gridIdx = dashboard.body.indexOf('class="detail-grid"');
    expect(contextIdx).toBeGreaterThan(-1);
    expect(gridIdx).toBeGreaterThan(-1);
    expect(contextIdx).toBeLessThan(gridIdx);
  });

  it("omits context section when pipeline_stage, activity_summary, health_reason, and rework_count are all absent", async () => {
    const baseRow = createSnapshot().running[0]!;
    const snapshotNoContext: RuntimeSnapshot = {
      ...createSnapshot(),
      running: [
        {
          ...baseRow,
          pipeline_stage: null,
          activity_summary: null,
          health: "green",
          health_reason: null,
        },
      ],
    };
    const server = await startDashboardServer({
      port: 0,
      host: createHost({
        getRuntimeSnapshot: () => snapshotNoContext,
      }),
    });
    servers.push(server);

    const dashboard = await sendRequest(server.port, {
      method: "GET",
      path: "/",
    });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.body).toContain("detail-panel");
    expect(dashboard.body).toContain("Token breakdown");
    // The rendered detail-row should not contain the context-section opening tag.
    // The JS code embeds class="context-section" as a string literal, so we check
    // only the server-rendered detail-row section (between detail-row and /tr).
    const detailRowStart = dashboard.body.indexOf('class="detail-row"');
    const detailRowEnd = dashboard.body.indexOf("</tr>", detailRowStart);
    expect(detailRowStart).toBeGreaterThan(-1);
    const detailRowHtml = dashboard.body.slice(detailRowStart, detailRowEnd);
    expect(detailRowHtml).not.toContain('class="context-section"');
    expect(detailRowHtml).toContain('class="detail-grid"');
  });

  it("shows context-health-red for stalled (red health) agent in detail panel", async () => {
    const baseRow = createSnapshot().running[0]!;
    const snapshotRed: RuntimeSnapshot = {
      ...createSnapshot(),
      running: [
        {
          ...baseRow,
          pipeline_stage: "investigate",
          activity_summary: null,
          health: "red",
          health_reason: "stalled: no activity for 145s",
        },
      ],
    };
    const server = await startDashboardServer({
      port: 0,
      host: createHost({
        getRuntimeSnapshot: () => snapshotRed,
      }),
    });
    servers.push(server);

    const dashboard = await sendRequest(server.port, {
      method: "GET",
      path: "/",
    });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.body).toContain("context-health-red");
    expect(dashboard.body).toContain("stalled: no activity for 145s");
    expect(dashboard.body).toContain("investigate");
    // The rendered context item uses context-health-red, not context-health-yellow
    expect(dashboard.body).not.toContain('class="context-health-yellow"');
  });

  it("renders an empty state for the running sessions table when there are no running sessions", async () => {
    const emptySnapshot: RuntimeSnapshot = {
      ...createSnapshot(),
      counts: { running: 0, retrying: 0, completed: 0, failed: 0 },
      running: [],
      retrying: [],
    };
    const server = await startDashboardServer({
      port: 0,
      host: createHost({
        getRuntimeSnapshot: () => emptySnapshot,
      }),
    });
    servers.push(server);

    const dashboard = await sendRequest(server.port, {
      method: "GET",
      path: "/",
    });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.body).toContain("No active sessions");
    // Server-rendered running-rows tbody should show empty state, not session rows
    expect(dashboard.body).toContain(
      'id="running-rows"><tr><td colspan="7"><p class="empty-state">No active sessions.</p></td></tr>',
    );
  });

  it("returns a plain 404 for undefined routes", async () => {
    const server = await startDashboardServer({
      port: 0,
      host: createHost(),
    });
    servers.push(server);

    const response = await sendRequest(server.port, {
      method: "GET",
      path: "/missing",
    });
    expect(response.statusCode).toBe(404);
    expect(response.headers["content-type"]).toContain("text/plain");
    expect(response.body).toContain("Not found: /missing");
  });
});

function createHost(
  overrides?: Partial<DashboardServerHost>,
): DashboardServerHost {
  const snapshot = createSnapshot();
  const issue = createIssueDetail();
  return {
    getRuntimeSnapshot: () => snapshot,
    getIssueDetails: (issueIdentifier) =>
      issueIdentifier === issue.issue_identifier ? issue : null,
    requestRefresh: () => ({
      queued: true,
      coalesced: false,
      requested_at: "2026-03-06T11:00:00.000Z",
      operations: ["poll", "reconcile"],
    }),
    ...overrides,
  };
}

function createSnapshot(): RuntimeSnapshot {
  return {
    generated_at: "2026-03-06T10:00:00.000Z",
    counts: {
      running: 1,
      retrying: 1,
      completed: 0,
      failed: 0,
    },
    running: [
      {
        issue_id: "issue-1",
        issue_identifier: "ABC-123",
        issue_title: "ABC-123",
        state: "In Progress",
        pipeline_stage: null,
        activity_summary: "Working on tests",
        session_id: "thread-1-turn-3",
        turn_count: 3,
        last_event: "notification",
        last_message: "Working on tests",
        started_at: "2026-03-06T09:58:00.000Z",
        first_dispatched_at: "2026-03-06T09:58:00.000Z",
        last_event_at: "2026-03-06T09:59:30.000Z",
        stage_duration_seconds: 120,
        tokens_per_turn: 667,
        tokens: {
          input_tokens: 1200,
          output_tokens: 800,
          total_tokens: 2000,
          cache_read_tokens: 300,
          cache_write_tokens: 150,
          reasoning_tokens: 50,
        },
        total_pipeline_tokens: 2000,
        execution_history: [],
        turn_history: [],
        recent_activity: [],
        health: "green",
        health_reason: null,
      },
    ],
    retrying: [
      {
        issue_id: "issue-2",
        issue_identifier: "ABC-124",
        attempt: 2,
        due_at: "2026-03-06T10:01:00.000Z",
        error: "no available orchestrator slots",
      },
    ],
    codex_totals: {
      input_tokens: 1200,
      output_tokens: 800,
      total_tokens: 2000,
      seconds_running: 153.2,
    },
    rate_limits: {
      requestsRemaining: 7,
    },
  };
}

function createIssueDetail(): IssueDetailResponse {
  return {
    issue_identifier: "ABC-123",
    issue_id: "issue-1",
    status: "running",
    workspace: {
      path: "/tmp/symphony/ABC-123",
    },
    attempts: {
      restart_count: 1,
      current_retry_attempt: null,
    },
    running: {
      session_id: "thread-1-turn-3",
      turn_count: 3,
      state: "In Progress",
      started_at: "2026-03-06T09:58:00.000Z",
      last_event: "notification",
      last_message: "Working on tests",
      last_event_at: "2026-03-06T09:59:30.000Z",
      tokens: {
        input_tokens: 1200,
        output_tokens: 800,
        total_tokens: 2000,
      },
    },
    retry: null,
    logs: {
      codex_session_logs: [
        {
          label: "latest",
          path: "/var/log/symphony/ABC-123/latest.log",
          url: null,
        },
      ],
    },
    recent_events: [
      {
        at: "2026-03-06T09:59:30.000Z",
        event: "notification",
        message: "Working on tests",
      },
    ],
    last_error: null,
    tracked: {},
  };
}

function sendRequest(
  port: number,
  input: {
    method: string;
    path: string;
    body?: string;
    headers?: Record<string, string>;
  },
): Promise<{
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: input.method,
        path: input.path,
        headers: input.headers,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );

    request.on("error", reject);
    if (input.body !== undefined) {
      request.write(input.body);
    }
    request.end();
  });
}

async function openEventStream(
  port: number,
  path: string,
): Promise<{
  close(): void;
  nextEvent(): Promise<{ event: string; data: string }>;
}> {
  const eventQueue: Array<{ event: string; data: string }> = [];
  const waitingResolvers: Array<
    (value: { event: string; data: string }) => void
  > = [];
  let buffer = "";
  let responseRef: IncomingMessage | null = null;

  const request = httpRequest({
    host: "127.0.0.1",
    port,
    method: "GET",
    path,
  });

  await new Promise<void>((resolve, reject) => {
    request.on("response", (response) => {
      responseRef = response;
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        buffer += chunk;

        while (buffer.includes("\n\n")) {
          const separatorIndex = buffer.indexOf("\n\n");
          const rawEvent = buffer.slice(0, separatorIndex);
          buffer = buffer.slice(separatorIndex + 2);
          const parsed = parseServerSentEvent(rawEvent);
          if (parsed === null) {
            continue;
          }

          const resolver = waitingResolvers.shift();
          if (resolver !== undefined) {
            resolver(parsed);
            continue;
          }
          eventQueue.push(parsed);
        }
      });
      resolve();
    });
    request.on("error", reject);
    request.end();
  });

  return {
    close() {
      responseRef?.destroy();
      request.destroy();
    },
    async nextEvent() {
      const queued = eventQueue.shift();
      if (queued !== undefined) {
        return queued;
      }

      return await new Promise((resolve) => {
        waitingResolvers.push(resolve);
      });
    },
  };
}

function parseServerSentEvent(
  payload: string,
): { event: string; data: string } | null {
  const lines = payload
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  const eventLine = lines.find((line) => line.startsWith("event: "));
  const dataLine = lines.find((line) => line.startsWith("data: "));
  if (eventLine === undefined || dataLine === undefined) {
    return null;
  }

  return {
    event: eventLine.slice("event: ".length),
    data: dataLine.slice("data: ".length),
  };
}
