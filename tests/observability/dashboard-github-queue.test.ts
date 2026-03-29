import { type IncomingMessage, request as httpRequest } from "node:http";

import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeSnapshot } from "../../src/logging/runtime-snapshot.js";
import {
  type DashboardServerHost,
  type ExecGh,
  startDashboardServer,
} from "../../src/observability/dashboard-server.js";

const samplePRs = JSON.stringify([
  {
    number: 1,
    title: "feat: add widget",
    url: "https://github.com/org/repo/pull/1",
    author: { login: "alice" },
    state: "OPEN",
    mergedAt: null,
    labels: [{ name: "ready" }],
  },
  {
    number: 2,
    title: "fix: button color",
    url: "https://github.com/org/repo/pull/2",
    author: { login: "bob" },
    state: "MERGED",
    mergedAt: "2026-03-27T12:00:00Z",
    labels: [],
  },
  {
    number: 3,
    title: "chore: broken PR",
    url: "https://github.com/org/repo/pull/3",
    author: { login: "carol" },
    state: "CLOSED",
    mergedAt: null,
    labels: [{ name: "rejected" }],
  },
]);

const sampleIssues = JSON.stringify([
  {
    number: 10,
    title: "Pipeline halted: flaky test",
    url: "https://github.com/org/repo/issues/10",
    createdAt: "2026-03-27T11:00:00Z",
  },
]);

function createMockExecGh(): ExecGh & { calls: string[][] } {
  const calls: string[][] = [];
  const fn = async (args: string[]) => {
    calls.push(args);
    if (args.includes("issue")) {
      return sampleIssues;
    }
    return samplePRs;
  };
  fn.calls = calls;
  return fn;
}

function createFailingExecGh(errorMessage: string): ExecGh {
  return async () => {
    throw new Error(errorMessage);
  };
}

function createHost(): DashboardServerHost {
  const snapshot: RuntimeSnapshot = {
    generated_at: "2026-03-28T10:00:00.000Z",
    counts: { running: 0, retrying: 0, completed: 0, failed: 0 },
    running: [],
    retrying: [],
    codex_totals: {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      seconds_running: 0,
    },
    rate_limits: { requestsRemaining: 10 },
  };
  return {
    getRuntimeSnapshot: () => snapshot,
    getIssueDetails: () => null,
    requestRefresh: () => ({
      queued: true,
      coalesced: false,
      requested_at: new Date().toISOString(),
      operations: [],
    }),
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
      (response: IncomingMessage) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer | string) => {
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

describe("GET /api/v1/github/queue", () => {
  const servers: Array<{ close: () => Promise<void> }> = [];
  const savedRepoUrl = process.env.REPO_URL;

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((s) => s.close()));
    if (savedRepoUrl === undefined) {
      // biome-ignore lint/performance/noDelete: delete required - process.env coerces undefined to string "undefined"
      delete process.env.REPO_URL;
    } else {
      process.env.REPO_URL = savedRepoUrl;
    }
  });

  it("returns 405 for non-GET methods", async () => {
    const server = await startDashboardServer({
      port: 0,
      host: createHost(),
      githubRepoSlug: "org/repo",
      execGh: createMockExecGh(),
    });
    servers.push(server);

    const response = await sendRequest(server.port, {
      method: "POST",
      path: "/api/v1/github/queue",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    expect(response.statusCode).toBe(405);
    expect(response.headers.allow).toBe("GET");
    expect(JSON.parse(response.body)).toEqual({
      error: {
        code: "method_not_allowed",
        message: "Method not allowed.",
      },
    });
  });

  it("returns 500 when no repo slug is configured", async () => {
    // biome-ignore lint/performance/noDelete: delete required - process.env coerces undefined to string "undefined"
    delete process.env.REPO_URL;
    const server = await startDashboardServer({
      port: 0,
      host: createHost(),
    });
    servers.push(server);

    const response = await sendRequest(server.port, {
      method: "GET",
      path: "/api/v1/github/queue",
    });
    expect(response.statusCode).toBe(500);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("github_cli_failed");
    expect(body.error.message).toContain("not configured");
  });

  it("resolves repo slug from REPO_URL env var", async () => {
    process.env.REPO_URL = "https://github.com/myorg/myrepo.git";
    const mockExecGh = createMockExecGh();

    const server = await startDashboardServer({
      port: 0,
      host: createHost(),
      execGh: mockExecGh,
    });
    servers.push(server);

    const response = await sendRequest(server.port, {
      method: "GET",
      path: "/api/v1/github/queue",
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.repo).toBe("myorg/myrepo");
    // Verify the repo slug was passed to gh commands
    expect(mockExecGh.calls[0]).toContain("myorg/myrepo");
  });

  it("returns categorized PRs and alerts on success", async () => {
    const server = await startDashboardServer({
      port: 0,
      host: createHost(),
      githubRepoSlug: "org/repo",
      execGh: createMockExecGh(),
    });
    servers.push(server);

    const response = await sendRequest(server.port, {
      method: "GET",
      path: "/api/v1/github/queue",
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);

    expect(body.repo).toBe("org/repo");
    expect(body.cached).toBe(false);
    expect(body.fetched_at).toBeTruthy();

    // OPEN PRs → in_queue
    expect(body.in_queue).toHaveLength(1);
    expect(body.in_queue[0].number).toBe(1);
    expect(body.in_queue[0].author).toBe("alice");
    expect(body.in_queue[0].labels).toEqual(["ready"]);

    // MERGED PRs → recently_merged
    expect(body.recently_merged).toHaveLength(1);
    expect(body.recently_merged[0].number).toBe(2);
    expect(body.recently_merged[0].mergedAt).toBe("2026-03-27T12:00:00Z");

    // CLOSED PRs → rejected
    expect(body.rejected).toHaveLength(1);
    expect(body.rejected[0].number).toBe(3);

    // Issues with pipeline-halt label → alerts
    expect(body.alerts).toHaveLength(1);
    expect(body.alerts[0].number).toBe(10);
    expect(body.alerts[0].title).toContain("Pipeline halted");
  });

  it("returns cached response on second request within 15 seconds", async () => {
    const mockExecGh = createMockExecGh();
    const server = await startDashboardServer({
      port: 0,
      host: createHost(),
      githubRepoSlug: "org/repo",
      execGh: mockExecGh,
    });
    servers.push(server);

    // First request — fresh
    const first = await sendRequest(server.port, {
      method: "GET",
      path: "/api/v1/github/queue",
    });
    expect(first.statusCode).toBe(200);
    const firstBody = JSON.parse(first.body);
    expect(firstBody.cached).toBe(false);

    // Second request — should be cached
    const second = await sendRequest(server.port, {
      method: "GET",
      path: "/api/v1/github/queue",
    });
    expect(second.statusCode).toBe(200);
    const secondBody = JSON.parse(second.body);
    expect(secondBody.cached).toBe(true);
    expect(secondBody.fetched_at).toBe(firstBody.fetched_at);

    // execGh should have been called only for the first request (2 calls: pr + issue)
    expect(mockExecGh.calls).toHaveLength(2);
  });

  it("returns 502 when gh CLI fails", async () => {
    const server = await startDashboardServer({
      port: 0,
      host: createHost(),
      githubRepoSlug: "org/repo",
      execGh: createFailingExecGh("Command failed: gh pr list"),
    });
    servers.push(server);

    const response = await sendRequest(server.port, {
      method: "GET",
      path: "/api/v1/github/queue",
    });
    expect(response.statusCode).toBe(502);
    const body = JSON.parse(response.body);
    expect(body.error.code).toBe("github_cli_failed");
    expect(body.error.message).toContain("Command failed");
  });

  it("includes CORS headers on github queue responses", async () => {
    const server = await startDashboardServer({
      port: 0,
      host: createHost(),
      githubRepoSlug: "org/repo",
      execGh: createMockExecGh(),
    });
    servers.push(server);

    const response = await sendRequest(server.port, {
      method: "GET",
      path: "/api/v1/github/queue",
    });
    expect(response.headers["access-control-allow-origin"]).toBe("*");
  });

  it("returns PR data with empty alerts when gh issue list fails", async () => {
    const execGh: ExecGh = async (args: string[]) => {
      if (args.includes("issue")) {
        throw new Error("issues are disabled for this repo");
      }
      return samplePRs;
    };

    const server = await startDashboardServer({
      port: 0,
      host: createHost(),
      githubRepoSlug: "org/repo",
      execGh,
    });
    servers.push(server);

    const response = await sendRequest(server.port, {
      method: "GET",
      path: "/api/v1/github/queue",
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);

    // PR data is still returned
    expect(body.repo).toBe("org/repo");
    expect(body.in_queue).toHaveLength(1);
    expect(body.in_queue[0].number).toBe(1);
    expect(body.recently_merged).toHaveLength(1);
    expect(body.rejected).toHaveLength(1);

    // Alerts are empty because issue list failed
    expect(body.alerts).toEqual([]);
  });

  it("prefers explicit githubRepoSlug over REPO_URL env var", async () => {
    process.env.REPO_URL = "https://github.com/env/repo.git";
    const mockExecGh = createMockExecGh();
    const server = await startDashboardServer({
      port: 0,
      host: createHost(),
      githubRepoSlug: "explicit/repo",
      execGh: mockExecGh,
    });
    servers.push(server);

    const response = await sendRequest(server.port, {
      method: "GET",
      path: "/api/v1/github/queue",
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(body.repo).toBe("explicit/repo");
  });
});
