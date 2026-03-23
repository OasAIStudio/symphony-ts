import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  CLI_ACKNOWLEDGEMENT_FLAG,
  applyCliOverrides,
  parseCliArgs,
  runCli,
  shouldRunAsCli,
} from "../../src/cli/main.js";
import type { ResolvedWorkflowConfig } from "../../src/config/types.js";

describe("cli", () => {
  it("parses the workflow path and CLI override flags", () => {
    expect(
      parseCliArgs([
        "config/WORKFLOW.md",
        "--logs-root",
        "./logs",
        "--port=8080",
        CLI_ACKNOWLEDGEMENT_FLAG,
      ]),
    ).toEqual({
      workflowPath: "config/WORKFLOW.md",
      logsRoot: "./logs",
      port: 8080,
      acknowledged: true,
      help: false,
      version: false,
    });
  });

  it("rejects unknown flags and duplicate positional arguments", () => {
    expect(() => parseCliArgs(["--unknown"])).toThrowError(
      "Unknown CLI argument: --unknown",
    );
    expect(() => parseCliArgs(["one.md", "two.md"])).toThrowError(
      "CLI accepts at most one positional workflow path argument.",
    );
  });

  it("applies CLI overrides with port precedence and absolute logs root", () => {
    const runtime = applyCliOverrides(
      createConfig({
        server: {
          port: 3000,
        },
      }),
      {
        workflowPath: null,
        logsRoot: "./runtime-logs",
        port: 8080,
        acknowledged: true,
        help: false,
        version: false,
      },
      "/repo",
    );

    expect(runtime.config.server.port).toBe(8080);
    expect(runtime.logsRoot).toBe("/repo/runtime-logs");
  });

  it("treats symlinked executables as the CLI entrypoint", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "symphony-task-cli-link-"));
    const cliPath = join(workspace, "main.js");
    const symlinkPath = join(workspace, "symphony");

    await writeFile(cliPath, "#!/usr/bin/env node\n", "utf8");
    await symlink(cliPath, symlinkPath);

    expect(shouldRunAsCli(pathToFileURL(cliPath).href, symlinkPath)).toBe(true);
  });

  it("returns false when the resolved entrypoint differs from the module path", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "symphony-task-cli-mismatch-"),
    );
    const cliPath = join(workspace, "main.js");
    const otherPath = join(workspace, "other.js");

    await writeFile(cliPath, "#!/usr/bin/env node\n", "utf8");
    await writeFile(otherPath, "#!/usr/bin/env node\n", "utf8");

    expect(shouldRunAsCli(pathToFileURL(cliPath).href, otherPath)).toBe(false);
  });

  it("defaults to loading ./WORKFLOW.md from cwd when no workflow path is given", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "symphony-task16-cli-"));
    const workflowPath = join(workspace, "WORKFLOW.md");
    await writeFile(workflowPath, "Prompt body\n", "utf8");

    const startHost = vi.fn(async () => ({
      async waitForExit() {
        return 0;
      },
    }));

    const exitCode = await runCli([CLI_ACKNOWLEDGEMENT_FLAG], {
      cwd: workspace,
      env: {},
      startHost,
    });

    expect(exitCode).toBe(0);
    expect(startHost).toHaveBeenCalledWith(
      expect.objectContaining({
        runtime: expect.objectContaining({
          config: expect.objectContaining({
            workflowPath,
          }),
        }),
      }),
    );
  });

  it("returns nonzero and skips startup when acknowledgement is missing", async () => {
    const stderr = vi.fn();
    const startHost = vi.fn();

    const exitCode = await runCli([], {
      io: {
        stdout: vi.fn(),
        stderr,
      },
      startHost,
    });

    expect(exitCode).toBe(1);
    expect(startHost).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining(CLI_ACKNOWLEDGEMENT_FLAG),
    );
  });

  it("returns nonzero when the workflow file is missing", async () => {
    const stderr = vi.fn();

    const exitCode = await runCli(["missing.md", CLI_ACKNOWLEDGEMENT_FLAG], {
      io: {
        stdout: vi.fn(),
        stderr,
      },
    });

    expect(exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledWith(
      expect.stringContaining("Unable to read workflow file"),
    );
  });

  it("returns success when the host starts and shuts down normally", async () => {
    const startHost = vi.fn(async () => ({
      async waitForExit() {
        return 0;
      },
    }));

    const exitCode = await runCli([CLI_ACKNOWLEDGEMENT_FLAG], {
      env: {},
      loadWorkflowDefinition: vi.fn(async () => ({
        workflowPath: "/repo/WORKFLOW.md",
        config: {},
        promptTemplate: "Prompt",
      })),
      startHost,
    });

    expect(exitCode).toBe(0);
    expect(startHost).toHaveBeenCalledOnce();
  });

  it("returns nonzero when startup fails or the host exits abnormally", async () => {
    const stderr = vi.fn();

    const startupFailure = await runCli([CLI_ACKNOWLEDGEMENT_FLAG], {
      io: {
        stdout: vi.fn(),
        stderr,
      },
      env: {},
      loadWorkflowDefinition: vi.fn(async () => ({
        workflowPath: "/repo/WORKFLOW.md",
        config: {},
        promptTemplate: "Prompt",
      })),
      startHost: vi.fn(async () => {
        throw new Error("boom");
      }),
    });

    const abnormalExit = await runCli([CLI_ACKNOWLEDGEMENT_FLAG], {
      io: {
        stdout: vi.fn(),
        stderr,
      },
      env: {},
      loadWorkflowDefinition: vi.fn(async () => ({
        workflowPath: "/repo/WORKFLOW.md",
        config: {},
        promptTemplate: "Prompt",
      })),
      startHost: vi.fn(async () => ({
        async waitForExit() {
          return 3;
        },
      })),
    });

    expect(startupFailure).toBe(1);
    expect(abnormalExit).toBe(3);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("boom"));
    expect(stderr).toHaveBeenCalledWith(
      "Symphony host exited abnormally with code 3.\n",
    );
  });

  it("prints version and exits 0 when --version is passed", async () => {
    const stdout = vi.fn();
    const exitCode = await runCli(["--version"], {
      io: { stdout, stderr: vi.fn() },
    });
    expect(exitCode).toBe(0);
    expect(stdout).toHaveBeenCalledWith(
      expect.stringMatching(/^symphony-ts .+\n$/),
    );
  });

  it("parses --version flag", () => {
    expect(parseCliArgs(["--version"])).toEqual(
      expect.objectContaining({ version: true }),
    );
  });
});

function createConfig(
  overrides: Partial<ResolvedWorkflowConfig> = {},
): ResolvedWorkflowConfig {
  return {
    workflowPath: "/repo/WORKFLOW.md",
    promptTemplate: "Prompt",
    tracker: {
      kind: "linear",
      endpoint: "https://api.linear.app/graphql",
      apiKey: "token",
      projectSlug: "ENG",
      activeStates: ["Todo"],
      terminalStates: ["Done"],
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
      maxRetryAttempts: 5,
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
    observability: {
      dashboardEnabled: true,
      refreshMs: 1_000,
      renderIntervalMs: 16,
    },
    runner: {
      kind: "codex",
      model: null,
    },
    stages: null,
    escalationState: null,
    ...overrides,
  };
}
