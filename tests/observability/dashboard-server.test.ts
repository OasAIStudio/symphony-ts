import { request as httpRequest } from "node:http";

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

    expect(server.hostname).toBe("127.0.0.1");
    expect(server.port).toBeGreaterThan(0);

    const dashboard = await sendRequest(server.port, {
      method: "GET",
      path: "/",
    });
    expect(dashboard.statusCode).toBe(200);
    expect(dashboard.headers["content-type"]).toContain("text/html");
    expect(dashboard.body).toContain("Symphony Dashboard");
    expect(dashboard.body).toContain("ABC-123");

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
    },
    running: [
      {
        issue_id: "issue-1",
        issue_identifier: "ABC-123",
        state: "In Progress",
        session_id: "thread-1-turn-3",
        turn_count: 3,
        last_event: "notification",
        last_message: "Working on tests",
        started_at: "2026-03-06T09:58:00.000Z",
        last_event_at: "2026-03-06T09:59:30.000Z",
        tokens: {
          input_tokens: 1200,
          output_tokens: 800,
          total_tokens: 2000,
        },
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
