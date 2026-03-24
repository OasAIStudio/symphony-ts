/**
 * Tests for ops/token-report.mjs — SYMPH-129
 *
 * These tests validate the core extraction pipeline by setting up temp
 * directories that mimic $SYMPHONY_HOME and $SYMPHONY_LOG_DIR, writing
 * synthetic symphony.jsonl events, then invoking the extract subcommand.
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPT_PATH = join(__dirname, "../../ops/token-report.mjs");
const NODE_BIN = process.execPath;

function tmpDir() {
  const dir = join(
    tmpdir(),
    `token-report-test-${randomBytes(6).toString("hex")}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
}

function runExtract(
  symphonyHome: string,
  logDir: string,
  extraEnv: Record<string, string> = {},
) {
  const env = {
    ...process.env,
    SYMPHONY_HOME: symphonyHome,
    SYMPHONY_LOG_DIR: logDir,
    LINEAR_API_KEY: "", // Disable Linear for tests
    ...extraEnv,
  };
  return execFileSync(NODE_BIN, [SCRIPT_PATH, "extract"], {
    env,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 15000,
  });
}

function runExtractWithStderr(
  symphonyHome: string,
  logDir: string,
  extraEnv: Record<string, string> = {},
) {
  const env = {
    ...process.env,
    SYMPHONY_HOME: symphonyHome,
    SYMPHONY_LOG_DIR: logDir,
    LINEAR_API_KEY: "", // Disable Linear for tests
    ...extraEnv,
  };
  try {
    const stdout = execFileSync(NODE_BIN, [SCRIPT_PATH, "extract"], {
      env,
      encoding: "utf-8",
      timeout: 15000,
    });
    return { stdout, stderr: "" };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string };
    return { stdout: e.stdout || "", stderr: e.stderr || "" };
  }
}

function makeStageEvent(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    timestamp: "2026-03-24T10:00:00.000Z",
    level: "info",
    event: "stage_completed",
    message: "Stage completed.",
    issue_id: "abc-123",
    issue_identifier: "SYMPH-200",
    session_id: "sess-1",
    stage_name: "implement",
    outcome: "completed",
    input_tokens: 100,
    output_tokens: 200,
    total_tokens: 300,
    total_input_tokens: 1000,
    total_output_tokens: 2000,
    total_total_tokens: 3000,
    no_cache_tokens: 50,
    total_cache_read_tokens: 400,
    total_cache_write_tokens: 100,
    cache_read_tokens: 40,
    cache_write_tokens: 10,
    reasoning_tokens: 0,
    turns_used: 5,
    turn_count: 5,
    duration_ms: 60000,
    ...overrides,
  });
}

function readJsonlFile(path: string): Record<string, unknown>[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

describe("token-report.mjs extract", () => {
  let symphonyHome: string;
  let logDir: string;

  beforeEach(() => {
    symphonyHome = tmpDir();
    logDir = tmpDir();
  });

  afterEach(() => {
    rmSync(symphonyHome, { recursive: true, force: true });
    rmSync(logDir, { recursive: true, force: true });
  });

  it("extracts token history from fresh logs across 2 products", () => {
    // Setup 2 product log dirs with events
    for (const product of ["product-a", "product-b"]) {
      const dir = join(logDir, product);
      mkdirSync(dir, { recursive: true });
      const events =
        product === "product-a"
          ? [
              makeStageEvent({ stage_name: "plan" }),
              makeStageEvent({ stage_name: "implement" }),
              makeStageEvent({ stage_name: "review" }),
            ]
          : [
              makeStageEvent({ stage_name: "plan" }),
              makeStageEvent({ stage_name: "implement" }),
            ];
      writeFileSync(join(dir, "symphony.jsonl"), `${events.join("\n")}\n`);
    }

    runExtract(symphonyHome, logDir);

    const historyPath = join(symphonyHome, "data", "token-history.jsonl");
    const records = readJsonlFile(historyPath);
    expect(records).toHaveLength(5);

    // Product field derived from directory path
    const productA = records.filter((r) => r.product === "product-a");
    const productB = records.filter((r) => r.product === "product-b");
    expect(productA).toHaveLength(3);
    expect(productB).toHaveLength(2);

    // Config history should have 1 record
    const configPath = join(symphonyHome, "data", "config-history.jsonl");
    const configs = readJsonlFile(configPath);
    expect(configs).toHaveLength(1);
    expect(configs[0]!.config_hashes).toBeDefined();

    // HWM files should exist
    const hwmDir = join(symphonyHome, "data", ".hwm");
    expect(existsSync(hwmDir)).toBe(true);
  });

  it("extracts both completed and failed stages", () => {
    const dir = join(logDir, "myproduct");
    mkdirSync(dir, { recursive: true });
    const events = [
      makeStageEvent({ outcome: "completed", stage_name: "s1" }),
      makeStageEvent({ outcome: "completed", stage_name: "s2" }),
      makeStageEvent({ outcome: "completed", stage_name: "s3" }),
      makeStageEvent({ outcome: "failed", stage_name: "s4" }),
      makeStageEvent({ outcome: "failed", stage_name: "s5" }),
    ];
    writeFileSync(join(dir, "symphony.jsonl"), `${events.join("\n")}\n`);

    runExtract(symphonyHome, logDir);

    const records = readJsonlFile(
      join(symphonyHome, "data", "token-history.jsonl"),
    );
    expect(records).toHaveLength(5);
    const completed = records.filter((r) => r.outcome === "completed");
    const failed = records.filter((r) => r.outcome === "failed");
    expect(completed).toHaveLength(3);
    expect(failed).toHaveLength(2);
  });

  it("idempotent re-extraction produces no duplicates", () => {
    const dir = join(logDir, "prod");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "symphony.jsonl"),
      `${[makeStageEvent(), makeStageEvent({ stage_name: "review" })].join("\n")}\n`,
    );

    runExtract(symphonyHome, logDir);
    const countBefore = readJsonlFile(
      join(symphonyHome, "data", "token-history.jsonl"),
    ).length;

    // Run again — no new events
    runExtract(symphonyHome, logDir);
    const countAfter = readJsonlFile(
      join(symphonyHome, "data", "token-history.jsonl"),
    ).length;

    expect(countAfter).toBe(countBefore);

    // Config history gains exactly 1 new snapshot
    const configs = readJsonlFile(
      join(symphonyHome, "data", "config-history.jsonl"),
    );
    expect(configs).toHaveLength(2);
  });

  it("handles HWM recovery after file truncation", () => {
    const dir = join(logDir, "prod");
    mkdirSync(dir, { recursive: true });
    const logPath = join(dir, "symphony.jsonl");

    // Write 3 events and extract
    writeFileSync(
      logPath,
      `${[makeStageEvent({ stage_name: "s1" }), makeStageEvent({ stage_name: "s2" }), makeStageEvent({ stage_name: "s3" })].join("\n")}\n`,
    );
    runExtract(symphonyHome, logDir);
    expect(
      readJsonlFile(join(symphonyHome, "data", "token-history.jsonl")),
    ).toHaveLength(3);

    // Truncate the file and write new event
    writeFileSync(logPath, `${makeStageEvent({ stage_name: "s4" })}\n`);

    // Extract should detect truncation and re-read
    runExtract(symphonyHome, logDir);
    const records = readJsonlFile(
      join(symphonyHome, "data", "token-history.jsonl"),
    );
    expect(records).toHaveLength(4);
    expect(records[3]!.stage_name).toBe("s4");
  });

  it("discards partial line at EOF during active writing", () => {
    const dir = join(logDir, "prod");
    mkdirSync(dir, { recursive: true });
    const logPath = join(dir, "symphony.jsonl");

    // Write one complete event + one partial
    const completeEvent = makeStageEvent({ stage_name: "complete" });
    writeFileSync(logPath, `${completeEvent}\n{"event":"stage_com`);

    runExtract(symphonyHome, logDir);
    const records = readJsonlFile(
      join(symphonyHome, "data", "token-history.jsonl"),
    );
    expect(records).toHaveLength(1);
    expect(records[0]!.stage_name).toBe("complete");

    // Now complete the partial line and add a newline
    writeFileSync(
      logPath,
      `${completeEvent}\n${makeStageEvent({ stage_name: "was-partial" })}\n`,
    );

    runExtract(symphonyHome, logDir);
    const records2 = readJsonlFile(
      join(symphonyHome, "data", "token-history.jsonl"),
    );
    // Should pick up the now-completed line
    expect(records2).toHaveLength(2);
    expect(records2[1]!.stage_name).toBe("was-partial");
  });

  it("skips malformed JSONL lines without failing", () => {
    const dir = join(logDir, "prod");
    mkdirSync(dir, { recursive: true });
    const logPath = join(dir, "symphony.jsonl");

    const lines = [];
    for (let i = 0; i < 10; i++) {
      lines.push(makeStageEvent({ stage_name: `s${i}` }));
    }
    // Insert 2 malformed lines
    lines.splice(3, 0, "THIS IS NOT JSON");
    lines.splice(7, 0, "{broken json{{");

    writeFileSync(logPath, `${lines.join("\n")}\n`);

    // Run with captured stderr
    const env = {
      ...process.env,
      SYMPHONY_HOME: symphonyHome,
      SYMPHONY_LOG_DIR: logDir,
      LINEAR_API_KEY: "",
    };
    try {
      execFileSync(NODE_BIN, [SCRIPT_PATH, "extract"], {
        env,
        encoding: "utf-8",
        timeout: 15000,
      });
    } catch {
      // extract logs warnings to stderr but shouldn't throw
    }

    // Fallback: if the above didn't throw, read normally
    const records = readJsonlFile(
      join(symphonyHome, "data", "token-history.jsonl"),
    );
    expect(records).toHaveLength(10);
  });

  it("handles empty log directory gracefully", () => {
    const dir = join(logDir, "emptyproduct");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "symphony.jsonl"), ""); // Empty file

    runExtract(symphonyHome, logDir);

    const historyPath = join(symphonyHome, "data", "token-history.jsonl");
    if (existsSync(historyPath)) {
      const content = readFileSync(historyPath, "utf-8").trim();
      if (content.length > 0) {
        const records = content.split("\n").map((l) => JSON.parse(l));
        const emptyRecords = records.filter(
          (r) => r.product === "emptyproduct",
        );
        expect(emptyRecords).toHaveLength(0);
      }
    }
  });

  it("graceful degradation without Linear auth", () => {
    const dir = join(logDir, "prod");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "symphony.jsonl"),
      `${makeStageEvent({ issue_identifier: "SYMPH-999" })}\n`,
    );

    runExtract(symphonyHome, logDir, { LINEAR_API_KEY: "" });

    const records = readJsonlFile(
      join(symphonyHome, "data", "token-history.jsonl"),
    );
    expect(records).toHaveLength(1);
    expect(records[0]!.issue_title).toBeNull();
  });

  it("maps all required fields correctly", () => {
    const dir = join(logDir, "myproduct");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "symphony.jsonl"),
      `${makeStageEvent({
        total_input_tokens: 5000,
        total_output_tokens: 3000,
        total_total_tokens: 8000,
        no_cache_tokens: 1500,
        total_cache_read_tokens: 2000,
        total_cache_write_tokens: 500,
      })}\n`,
    );

    runExtract(symphonyHome, logDir);

    const records = readJsonlFile(
      join(symphonyHome, "data", "token-history.jsonl"),
    );
    expect(records).toHaveLength(1);
    const r = records[0]!;
    expect(r.product).toBe("myproduct");
    expect(r.stage_name).toBe("implement");
    expect(r.total_input_tokens).toBe(5000);
    expect(r.total_output_tokens).toBe(3000);
    expect(r.total_total_tokens).toBe(8000);
    expect(r.no_cache_tokens).toBe(1500);
    expect(r.total_cache_read_tokens).toBe(2000);
    expect(r.total_cache_write_tokens).toBe(500);
    expect(r.outcome).toBe("completed");
    expect(r.extracted_at).toBeDefined();
  });
});
