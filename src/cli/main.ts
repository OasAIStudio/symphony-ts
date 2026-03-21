#!/usr/bin/env node

import { realpathSync, writeSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { resolveWorkflowConfig } from "../config/config-resolver.js";
import { WORKFLOW_FILENAME } from "../config/defaults.js";
import { loadWorkflowDefinition } from "../config/workflow-loader.js";
import { ERROR_CODES } from "../errors/codes.js";
import {
  type RuntimeServiceHandle,
  startRuntimeService,
} from "../orchestrator/runtime-host.js";

export const CLI_ACKNOWLEDGEMENT_FLAG = "--acknowledge-high-trust-preview";

export interface CliOptions {
  workflowPath: string | null;
  logsRoot: string | null;
  port: number | null;
  acknowledged: boolean;
  help: boolean;
}

export interface CliRuntimeSettings {
  config: ReturnType<typeof resolveWorkflowConfig>;
  logsRoot: string | null;
}

export interface CliHost {
  waitForExit(): Promise<number | undefined>;
  shutdown?(): Promise<void>;
}

export interface StartCliHostInput {
  options: CliOptions;
  runtime: CliRuntimeSettings;
}

export interface CliIo {
  stdout(message: string): void;
  stderr(message: string): void;
}

export interface CliDependencies {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  io?: CliIo;
  loadWorkflowDefinition?: typeof loadWorkflowDefinition;
  resolveWorkflowConfig?: typeof resolveWorkflowConfig;
  startHost?: (input: StartCliHostInput) => Promise<CliHost>;
}

export class CliUsageError extends Error {
  readonly code = ERROR_CODES.cliStartupFailed;

  constructor(message: string) {
    super(message);
    this.name = "CliUsageError";
  }
}

export function parseCliArgs(argv: readonly string[]): CliOptions {
  let workflowPath: string | null = null;
  let logsRoot: string | null = null;
  let port: number | null = null;
  let acknowledged = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) {
      continue;
    }

    if (!token.startsWith("-")) {
      if (workflowPath !== null) {
        throw new CliUsageError(
          "CLI accepts at most one positional workflow path argument.",
        );
      }

      workflowPath = token;
      continue;
    }

    if (token === "--help" || token === "-h") {
      help = true;
      continue;
    }

    if (token === CLI_ACKNOWLEDGEMENT_FLAG) {
      acknowledged = true;
      continue;
    }

    if (token === "--logs-root") {
      logsRoot = readValueFlag(argv, ++index, "--logs-root");
      continue;
    }

    if (token.startsWith("--logs-root=")) {
      logsRoot = token.slice("--logs-root=".length);
      ensureFlagValue(logsRoot, "--logs-root");
      continue;
    }

    if (token === "--port") {
      port = parsePort(readValueFlag(argv, ++index, "--port"));
      continue;
    }

    if (token.startsWith("--port=")) {
      port = parsePort(token.slice("--port=".length));
      continue;
    }

    throw new CliUsageError(`Unknown CLI argument: ${token}`);
  }

  return {
    workflowPath,
    logsRoot,
    port,
    acknowledged,
    help,
  };
}

export function applyCliOverrides(
  config: ReturnType<typeof resolveWorkflowConfig>,
  options: CliOptions,
  cwd = process.cwd(),
): CliRuntimeSettings {
  return {
    config: {
      ...config,
      server: {
        ...config.server,
        port: options.port ?? config.server.port,
      },
    },
    logsRoot: options.logsRoot === null ? null : resolve(cwd, options.logsRoot),
  };
}

export async function startCliHost(
  input: StartCliHostInput,
): Promise<RuntimeServiceHandle> {
  return startRuntimeService({
    config: input.runtime.config,
    logsRoot: input.runtime.logsRoot,
  });
}

export async function runCli(
  argv: readonly string[],
  dependencies: CliDependencies = {},
): Promise<number> {
  const cwd = dependencies.cwd ?? process.cwd();
  const env = dependencies.env ?? process.env;
  const io = dependencies.io ?? {
    stdout: (message: string) => process.stdout.write(message),
    stderr: (message: string) => process.stderr.write(message),
  };
  const loadWorkflow =
    dependencies.loadWorkflowDefinition ?? loadWorkflowDefinition;
  const resolveConfig =
    dependencies.resolveWorkflowConfig ?? resolveWorkflowConfig;
  const startHost = dependencies.startHost ?? startCliHost;

  let options: CliOptions;
  try {
    options = parseCliArgs(argv);
  } catch (error) {
    io.stderr(`${formatCliError(error)}\n${renderUsage()}`);
    return 1;
  }

  if (options.help) {
    io.stdout(renderUsage());
    return 0;
  }

  if (!options.acknowledged) {
    io.stderr(
      `Refusing to start without ${CLI_ACKNOWLEDGEMENT_FLAG}. Symphony is a high-trust preview intended for trusted environments.\n`,
    );
    return 1;
  }

  try {
    const workflowPath =
      options.workflowPath === null
        ? resolve(cwd, WORKFLOW_FILENAME)
        : resolve(cwd, options.workflowPath);
    const workflow = await loadWorkflow(workflowPath);
    const config = resolveConfig(workflow, env);
    const runtime = applyCliOverrides(config, options, cwd);
    const host = await startHost({
      options,
      runtime,
    });
    const exitCode = await host.waitForExit();

    if (typeof exitCode === "number" && exitCode !== 0) {
      io.stderr(`Symphony host exited abnormally with code ${exitCode}.\n`);
      return exitCode;
    }

    return 0;
  } catch (error) {
    io.stderr(`${formatCliError(error)}\n`);
    return 1;
  }
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  try {
    return String(error);
  } catch {
    return "[non-stringifiable value]";
  }
}

export function handleUncaughtException(error: unknown): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level: "error",
    event: "process_crash",
    message: safeErrorMessage(error),
    error_code: "uncaught_exception",
    stack: error instanceof Error ? error.stack : undefined,
  };
  process.exitCode = 70;
  try {
    writeSync(2, `${JSON.stringify(entry)}\n`);
  } catch {
    // Ignore write errors during crash — exiting is the priority.
  }
  process.exit(70);
}

export function handleUnhandledRejection(reason: unknown): void {
  const entry = {
    timestamp: new Date().toISOString(),
    level: "error",
    event: "process_crash",
    message: safeErrorMessage(reason),
    error_code: "unhandled_rejection",
    stack: reason instanceof Error ? reason.stack : undefined,
  };
  process.exitCode = 70;
  try {
    writeSync(2, `${JSON.stringify(entry)}\n`);
  } catch {
    // Ignore write errors during crash — exiting is the priority.
  }
  process.exit(70);
}

export async function main(): Promise<void> {
  const exitCode = await runCli(process.argv.slice(2));
  process.exitCode = exitCode;
}

export function shouldRunAsCli(
  importMetaUrl: string,
  entryPath: string | undefined,
): boolean {
  if (!entryPath) {
    return false;
  }

  try {
    return (
      realpathSync(fileURLToPath(importMetaUrl)) === realpathSync(entryPath)
    );
  } catch {
    return importMetaUrl === pathToFileURL(entryPath).href;
  }
}

function readValueFlag(
  argv: readonly string[],
  index: number,
  flag: string,
): string {
  const value = argv[index];
  ensureFlagValue(value, flag);
  return value;
}

function ensureFlagValue(
  value: string | undefined,
  flag: string,
): asserts value is string {
  if (!value || value.startsWith("-")) {
    throw new CliUsageError(`Missing value for ${flag}.`);
  }
}

function parsePort(rawPort: string): number {
  if (!/^\d+$/.test(rawPort.trim())) {
    throw new CliUsageError(`Invalid value for --port: ${rawPort}`);
  }

  return Number.parseInt(rawPort, 10);
}

function formatCliError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  return "Symphony failed to start.";
}

function renderUsage(): string {
  return [
    "Usage: symphony [path-to-WORKFLOW.md] [options]",
    "",
    "Options:",
    `  ${CLI_ACKNOWLEDGEMENT_FLAG}  required before startup`,
    "  --logs-root <path>           override the logs root directory",
    "  --port <number>              override the HTTP server port",
    "  --help                       show this help text",
    "",
  ].join("\n");
}

if (shouldRunAsCli(import.meta.url, process.argv[1])) {
  process.on("uncaughtException", handleUncaughtException);
  process.on("unhandledRejection", handleUnhandledRejection);
  void main().catch(handleUnhandledRejection);
}
