import { type IncomingMessage, request as httpRequest } from "node:http";
import { dirname, resolve as pathResolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import type { RuntimeSnapshot } from "../../src/logging/runtime-snapshot.js";
import {
  type DashboardServerHost,
  type DeployPreviewResponse,
  resolveDeployScriptPath,
  startDashboardServer,
} from "../../src/observability/dashboard-server.js";

describe("resolveDeployScriptPath", () => {
  it("resolves 3 levels up from dist/src/observability/ to repo root", () => {
    const deployPath = resolveDeployScriptPath();

    // The path must end with ops/symphony-deploy
    expect(deployPath).toMatch(/ops\/symphony-deploy$/);

    // Simulate the dist/ scenario to verify the 3-level traversal is correct:
    // In production the module lives at dist/src/observability/dashboard-server.js,
    // so going 3 levels up from dist/src/observability/ reaches the repo root.
    const repoRoot = pathResolve(
      dirname(fileURLToPath(import.meta.url)),
      "..",
      "..",
    );
    const fakeDistDir = pathResolve(
      repoRoot,
      "dist",
      "src",
      "observability",
    );
    const fromDist = pathResolve(
      fakeDistDir,
      "..",
      "..",
      "..",
      "ops",
      "symphony-deploy",
    );
    // 3 levels up from dist/src/observability/ lands at repo root
    expect(fromDist).toBe(pathResolve(repoRoot, "ops", "symphony-deploy"));

    // With only 2 levels (the old bug), it would resolve inside dist/
    const fromDistBug = pathResolve(
      fakeDistDir,
      "..",
      "..",
      "ops",
      "symphony-deploy",
    );
    expect(fromDistBug).toBe(
      pathResolve(repoRoot, "dist", "ops", "symphony-deploy"),
    );
  });
});

describe("deploy endpoints", () => {
  const servers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => server.close()));
  });

  // ── Deploy Preview ──────────────────────────────────────────────

  it("POST /api/v1/deploy/preview returns structured dry-run output", async () => {
    const dryRunOutput = [
      "▸ symphony-deploy [DRY RUN]",
      "",
      "▸ === symphony-ts ===",
      "▸ Pre-deploy version: 2026.03.23.1",
      "▸ Ensuring symphony-ts is on main...",
      "▸ [dry-run] git -C /home/user/projects/symphony-ts checkout main",
      "▸ Pulling symphony-ts (/home/user/projects/symphony-ts)...",
      "▸ [dry-run] git -C /home/user/projects/symphony-ts pull --ff-only",
      "✓ symphony-ts already up to date (abc12345)",
      "",
      "✓ .env is current — skipping decrypt",
      "",
      "▸ === Summary ===",
      "  symphony-ts:   abc12345 → abc12345",
      "▸ Post-deploy version: 2026.03.24.1",
      "",
      "▸ Dry run complete — no changes were made.",
    ].join("\n");

    const server = await startDashboardServer({
      port: 0,
      host: createHost(),
      execDeploy: async (args) => {
        expect(args).toEqual(["--dry-run"]);
        return dryRunOutput;
      },
    });
    servers.push(server);

    const response = await sendRequest(server.port, {
      method: "POST",
      path: "/api/v1/deploy/preview",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.body) as DeployPreviewResponse;
    expect(body).toHaveProperty("current_version");
    expect(body).toHaveProperty("target_version");
    expect(body).toHaveProperty("commits_ahead");
    expect(body).toHaveProperty("actions");
    expect(body).toHaveProperty("running_issues_count");
    expect(body.current_version).toBe("2026.03.23.1");
    expect(body.target_version).toBe("2026.03.24.1");
    expect(body.running_issues_count).toBe(1);
    expect(body.actions.length).toBeGreaterThan(0);
    expect(body.actions).toContain(
      "git -C /home/user/projects/symphony-ts checkout main",
    );
    expect(body.actions).toContain(
      "git -C /home/user/projects/symphony-ts pull --ff-only",
    );
  });

  it("POST /api/v1/deploy/preview includes running_issues_count from snapshot", async () => {
    const server = await startDashboardServer({
      port: 0,
      host: createHost({
        getRuntimeSnapshot: () => ({
          ...createSnapshot(),
          counts: { running: 3, retrying: 0, completed: 0, failed: 0 },
        }),
      }),
      execDeploy: async () =>
        [
          "▸ Pre-deploy version: 1.0.0",
          "▸ Post-deploy version: 1.0.1",
          "  symphony-ts:   aaa11111 → bbb22222",
        ].join("\n"),
    });
    servers.push(server);

    const response = await sendRequest(server.port, {
      method: "POST",
      path: "/api/v1/deploy/preview",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.body) as DeployPreviewResponse;
    expect(body.running_issues_count).toBe(3);
    expect(body.commits_ahead).toBe(1);
  });

  it("POST /api/v1/deploy/preview returns 500 when deploy script fails", async () => {
    const server = await startDashboardServer({
      port: 0,
      host: createHost(),
      execDeploy: async () => {
        throw new Error("deploy script not found");
      },
    });
    servers.push(server);

    const response = await sendRequest(server.port, {
      method: "POST",
      path: "/api/v1/deploy/preview",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    expect(response.statusCode).toBe(500);
    expect(JSON.parse(response.body)).toEqual({
      error: {
        code: "deploy_failed",
        message: "deploy script not found",
      },
    });
  });

  it("GET /api/v1/deploy/preview returns 405", async () => {
    const server = await startDashboardServer({
      port: 0,
      host: createHost(),
    });
    servers.push(server);

    const response = await sendRequest(server.port, {
      method: "GET",
      path: "/api/v1/deploy/preview",
    });
    expect(response.statusCode).toBe(405);
    expect(response.headers.allow).toBe("POST");
  });

  // ── Deploy Execute (SSE) ───────────────────────────────────────

  it("POST /api/v1/deploy streams SSE events with deploy_output type", async () => {
    const server = await startDashboardServer({
      port: 0,
      host: createHost(),
      spawnDeploy: (args) => {
        expect(args).toEqual([]);
        return createMockDeployProcess([
          "▸ symphony-deploy",
          "▸ Pulling symphony-ts...",
          "✓ Build complete",
        ]);
      },
    });
    servers.push(server);

    const stream = await openEventStream(server.port, "/api/v1/deploy", "POST");
    const events: Array<{ event: string; data: string }> = [];

    // Collect all events until deploy_complete
    let ev = await stream.nextEvent();
    while (ev.event !== "deploy_complete") {
      events.push(ev);
      ev = await stream.nextEvent();
    }
    events.push(ev); // push the deploy_complete too

    const outputEvents = events.filter((e) => e.event === "deploy_output");
    expect(outputEvents.length).toBe(3);
    expect(JSON.parse(outputEvents[0]!.data)).toEqual({
      line: "▸ symphony-deploy",
    });
    expect(JSON.parse(outputEvents[1]!.data)).toEqual({
      line: "▸ Pulling symphony-ts...",
    });
    expect(JSON.parse(outputEvents[2]!.data)).toEqual({
      line: "✓ Build complete",
    });

    const completeEvent = events.find((e) => e.event === "deploy_complete");
    expect(completeEvent).toBeDefined();
    const completeData = JSON.parse(completeEvent!.data);
    expect(completeData.success).toBe(true);
    expect(completeData.exit_code).toBe(0);

    stream.close();
  });

  it("POST /api/v1/deploy stream ends with deploy_complete event on failure", async () => {
    const server = await startDashboardServer({
      port: 0,
      host: createHost(),
      spawnDeploy: () => {
        return createMockDeployProcess(
          ["▸ symphony-deploy", "✗ Build failed"],
          1,
        );
      },
    });
    servers.push(server);

    const stream = await openEventStream(server.port, "/api/v1/deploy", "POST");
    const events: Array<{ event: string; data: string }> = [];

    let ev = await stream.nextEvent();
    while (ev.event !== "deploy_complete") {
      events.push(ev);
      ev = await stream.nextEvent();
    }
    events.push(ev);

    const completeEvent = events.find((e) => e.event === "deploy_complete");
    expect(completeEvent).toBeDefined();
    const completeData = JSON.parse(completeEvent!.data);
    expect(completeData.success).toBe(false);
    expect(completeData.exit_code).toBe(1);

    stream.close();
  });

  it("GET /api/v1/deploy returns 405", async () => {
    const server = await startDashboardServer({
      port: 0,
      host: createHost(),
    });
    servers.push(server);

    const response = await sendRequest(server.port, {
      method: "GET",
      path: "/api/v1/deploy",
    });
    expect(response.statusCode).toBe(405);
    expect(response.headers.allow).toBe("POST");
  });

  it("includes CORS headers on deploy preview responses", async () => {
    const server = await startDashboardServer({
      port: 0,
      host: createHost(),
      execDeploy: async () => "▸ Pre-deploy version: 1.0.0\n",
    });
    servers.push(server);

    const response = await sendRequest(server.port, {
      method: "POST",
      path: "/api/v1/deploy/preview",
      body: "{}",
      headers: { "content-type": "application/json" },
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["access-control-allow-origin"]).toBe("*");
  });
});

// ── Helpers ──────────────────────────────────────────────────────

function createHost(
  overrides?: Partial<DashboardServerHost>,
): DashboardServerHost {
  const snapshot = createSnapshot();
  return {
    getRuntimeSnapshot: () => snapshot,
    getIssueDetails: () => null,
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
      retrying: 0,
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
        activity_summary: null,
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
        pipeline_tokens: {
          input_tokens: 1000,
          output_tokens: 500,
          total_tokens: 2000,
          cache_read_tokens: 200,
          cache_write_tokens: 100,
        },
        execution_history: [],
        turn_history: [],
        recent_activity: [],
        last_tool_call: null,
        failure_reason: null,
        health: "green",
        health_reason: null,
      },
    ],
    retrying: [],
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

/**
 * Creates a mock ChildProcess that emits lines on stdout and exits with the
 * given code. Used to test the deploy SSE streaming endpoint.
 */
function createMockDeployProcess(
  lines: string[],
  exitCode = 0,
): import("node:child_process").ChildProcess {
  // biome-ignore format: multi-line typeof import() breaks esbuild
  const { EventEmitter } = require("node:events") as typeof import("node:events");
  const { Readable } = require("node:stream") as typeof import("node:stream");

  class MockProcess extends EventEmitter {
    readonly stdout: InstanceType<typeof Readable>;
    readonly stderr: InstanceType<typeof Readable>;
    readonly stdin = null;
    readonly pid = 12345;

    constructor() {
      super();
      this.stdout = new Readable({ read() {} });
      this.stderr = new Readable({ read() {} });

      // Push lines asynchronously so event listeners can attach
      setImmediate(() => {
        for (const line of lines) {
          this.stdout.push(`${line}\n`);
        }
        this.stdout.push(null);
        this.stderr.push(null);
        this.emit("close", exitCode);
      });
    }
  }

  // biome-ignore lint/suspicious/noExplicitAny: mock child process for testing
  return new MockProcess() as any;
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
  method = "GET",
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
    method,
    path,
    headers: { "content-type": "application/json" },
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
    // Send an empty body for POST
    if (method === "POST") {
      request.write("{}");
    }
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
