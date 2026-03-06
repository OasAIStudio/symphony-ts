import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { afterEach, describe, expect, it, vi } from "vitest";

import { CLI_ACKNOWLEDGEMENT_FLAG, runCli } from "../../src/cli/main.js";
import type { ResolvedWorkflowConfig } from "../../src/config/types.js";
import type { Issue } from "../../src/domain/model.js";
import type { PollTickResult } from "../../src/orchestrator/core.js";
import {
  OrchestratorRuntimeHost,
  type RuntimeHostStartupError,
  startRuntimeService,
} from "../../src/orchestrator/runtime-host.js";
import type {
  IssueStateSnapshot,
  IssueTracker,
} from "../../src/tracker/tracker.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    tempDirs.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("runtime integration", () => {
  it("starts the real runtime service, cleans terminal workspaces, and serves the dashboard", async () => {
    const root = await createTempDir("symphony-task16-runtime-");
    const logsRoot = join(root, "logs");
    const workspaceRoot = join(root, "workspaces");
    const terminalWorkspace = join(workspaceRoot, "DONE-1");

    await mkdir(terminalWorkspace, { recursive: true });
    await writeFile(join(terminalWorkspace, "artifact.txt"), "stale\n", "utf8");

    const tracker = createTracker({
      terminalIssues: [createIssue({ identifier: "DONE-1", state: "Done" })],
      candidates: [],
    });
    const stdout = new PassThrough();
    const service = await startRuntimeService({
      config: createConfig({
        workspace: {
          root: workspaceRoot,
        },
        server: {
          port: 0,
        },
      }),
      logsRoot,
      tracker,
      stdout,
    });

    expect(service.dashboard).not.toBeNull();
    expect(service.dashboard?.port ?? 0).toBeGreaterThan(0);
    await vi.waitFor(async () => {
      await expect(stat(terminalWorkspace)).rejects.toThrow();
    });

    const state = await sendRequest(service.dashboard?.port ?? 0, {
      method: "GET",
      path: "/api/v1/state",
    });
    expect(state.statusCode).toBe(200);
    expect(JSON.parse(state.body)).toMatchObject({
      counts: {
        running: 0,
        retrying: 0,
      },
    });

    await service.shutdown();
    expect(await service.waitForExit()).toBe(0);

    const logFile = await readFile(join(logsRoot, "symphony.jsonl"), "utf8");
    expect(logFile).toContain('"event":"runtime_starting"');
    expect(tracker.fetchIssuesByStates).toHaveBeenCalledWith([
      "Done",
      "Canceled",
    ]);
  });

  it("returns a nonzero exit code when the real runtime host exits abnormally", async () => {
    const root = await createTempDir("symphony-task16-cli-real-host-");
    const workflowPath = join(root, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---
tracker:
  kind: linear
  api_key: token
  project_slug: ENG
workspace:
  root: ${join(root, "workspaces")}
server:
  port: 0
---
Prompt body
`,
      "utf8",
    );

    const stderr = vi.fn();
    const tracker = createTracker({
      candidates: [],
    });
    const exitCode = await runCli(
      ["WORKFLOW.md", CLI_ACKNOWLEDGEMENT_FLAG, "--port", "0"],
      {
        cwd: root,
        env: {},
        io: {
          stdout: vi.fn(),
          stderr,
        },
        startHost: async ({ runtime }) => {
          const runtimeHost = new ThrowingRuntimeHost({
            config: runtime.config,
            tracker,
          });

          return await startRuntimeService({
            config: runtime.config,
            logsRoot: runtime.logsRoot,
            tracker,
            runtimeHost,
            stdout: new PassThrough(),
          });
        },
      },
    );

    expect(exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledWith(
      "Symphony host exited abnormally with code 1.\n",
    );
  });

  it("runs the CLI against the real runtime service and applies workflow path and port overrides", async () => {
    const root = await createTempDir("symphony-task16-cli-path-");
    const workflowDir = join(root, "config");
    await mkdir(workflowDir, { recursive: true });
    const workflowPath = join(workflowDir, "WORKFLOW.md");
    await writeFile(
      workflowPath,
      `---
tracker:
  kind: linear
  api_key: token
  project_slug: ENG
workspace:
  root: ${join(root, "workspaces")}
server:
  port: 4321
---
Prompt body
`,
      "utf8",
    );

    const observed: {
      config: ResolvedWorkflowConfig | null;
      logsRoot: string | null;
    } = {
      config: null,
      logsRoot: null,
    };
    const exitCode = await runCli(
      [
        "config/WORKFLOW.md",
        CLI_ACKNOWLEDGEMENT_FLAG,
        "--logs-root",
        "./runtime-logs",
        "--port",
        "0",
      ],
      {
        cwd: root,
        env: {},
        startHost: async ({ runtime }) => {
          observed.config = runtime.config;
          observed.logsRoot = runtime.logsRoot;
          const host = await startRuntimeService({
            config: runtime.config,
            logsRoot: runtime.logsRoot,
            tracker: createTracker({
              candidates: [],
            }),
            stdout: new PassThrough(),
          });
          setTimeout(() => {
            void host.shutdown();
          }, 10);
          return host;
        },
      },
    );

    expect(exitCode).toBe(0);
    expect(observed.config).not.toBeNull();
    if (observed.config === null) {
      throw new Error("Expected observed config to be captured.");
    }
    expect(observed.config.workflowPath).toBe(workflowPath);
    expect(observed.config.server.port).toBe(0);
    expect(observed.logsRoot).toBe(join(root, "runtime-logs"));
  });

  it("surfaces real startup validation failures from startRuntimeService", async () => {
    await expect(
      startRuntimeService({
        config: createConfig({
          tracker: {
            kind: "linear",
            endpoint: "https://api.linear.app/graphql",
            apiKey: null,
            projectSlug: "ENG",
            activeStates: ["Todo"],
            terminalStates: ["Done"],
          },
        }),
        tracker: createTracker(),
        stdout: new PassThrough(),
      }),
    ).rejects.toMatchObject({
      name: "RuntimeHostStartupError",
      code: "tracker_credentials_missing",
      message: "tracker.api_key must be configured before dispatch.",
    } satisfies Partial<RuntimeHostStartupError>);
  });
});

function createTracker(input?: {
  candidates?: Issue[];
  terminalIssues?: Issue[];
  candidatesError?: Error;
  stateSnapshots?: IssueStateSnapshot[];
}): IssueTracker & {
  fetchCandidateIssues: ReturnType<typeof vi.fn>;
  fetchIssuesByStates: ReturnType<typeof vi.fn>;
  fetchIssueStatesByIds: ReturnType<typeof vi.fn>;
} {
  const candidates = input?.candidates ?? [];
  const terminalIssues = input?.terminalIssues ?? [];
  const stateSnapshots = input?.stateSnapshots ?? [];

  return {
    fetchCandidateIssues: vi.fn(async () => {
      if (input?.candidatesError) {
        throw input.candidatesError;
      }
      return candidates;
    }),
    fetchIssuesByStates: vi.fn(async () => terminalIssues),
    fetchIssueStatesByIds: vi.fn(async () => stateSnapshots),
  };
}

class ThrowingRuntimeHost extends OrchestratorRuntimeHost {
  override async pollOnce(): Promise<PollTickResult> {
    throw new Error("poll exploded");
  }
}

function createIssue(overrides?: Partial<Issue>): Issue {
  return {
    id: "1",
    identifier: "ISSUE-1",
    title: "Issue 1",
    description: null,
    priority: 1,
    state: "In Progress",
    branchName: null,
    url: null,
    labels: [],
    blockedBy: [],
    createdAt: "2026-03-01T00:00:00.000Z",
    updatedAt: "2026-03-01T00:00:00.000Z",
    ...overrides,
  };
}

function createConfig(
  overrides: Partial<ResolvedWorkflowConfig> = {},
): ResolvedWorkflowConfig {
  return {
    workflowPath: "/tmp/WORKFLOW.md",
    promptTemplate: "Prompt",
    tracker: {
      kind: "linear",
      endpoint: "https://api.linear.app/graphql",
      apiKey: "token",
      projectSlug: "ENG",
      activeStates: ["Todo"],
      terminalStates: ["Done", "Canceled"],
    },
    polling: {
      intervalMs: 30_000,
    },
    workspace: {
      root: "/tmp/symphony",
    },
    hooks: {
      afterCreate: null,
      beforeRun: null,
      afterRun: null,
      beforeRemove: null,
      timeoutMs: 60_000,
    },
    agent: {
      maxConcurrentAgents: 10,
      maxTurns: 20,
      maxRetryBackoffMs: 300_000,
      maxConcurrentAgentsByState: {},
    },
    codex: {
      command: "codex app-server",
      approvalPolicy: null,
      threadSandbox: null,
      turnSandboxPolicy: null,
      turnTimeoutMs: 3_600_000,
      readTimeoutMs: 5_000,
      stallTimeoutMs: 300_000,
    },
    server: {
      port: null,
    },
    ...overrides,
  };
}

async function createTempDir(prefix: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

async function sendRequest(
  port: number,
  input: {
    method: string;
    path: string;
  },
): Promise<{
  statusCode: number;
  body: string;
}> {
  return await new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        method: input.method,
        path: input.path,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        response.on("end", () => {
          resolve({
            statusCode: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );

    request.on("error", reject);
    request.end();
  });
}
