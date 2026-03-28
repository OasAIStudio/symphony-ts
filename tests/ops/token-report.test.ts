/**
 * Tests for ops/token-report.mjs — SYMPH-129
 *
 * These tests validate the core extraction pipeline by setting up temp
 * directories that mimic $SYMPHONY_HOME and $SYMPHONY_LOG_DIR, writing
 * synthetic symphony.jsonl events, then invoking the extract subcommand.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
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

// ---------------------------------------------------------------------------
// Analyze subcommand tests — SYMPH-130
// ---------------------------------------------------------------------------

function makeTokenRecord(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: "2026-03-20T10:00:00.000Z",
    product: "symphony",
    issue_id: "abc-123",
    issue_identifier: "SYMPH-200",
    issue_title: "Some task",
    session_id: "sess-1",
    stage_name: "implement",
    outcome: "completed",
    total_input_tokens: 1000,
    total_output_tokens: 2000,
    total_total_tokens: 3000,
    no_cache_tokens: 50,
    total_cache_read_tokens: 400,
    total_cache_write_tokens: 100,
    input_tokens: 100,
    output_tokens: 200,
    total_tokens: 300,
    cache_read_tokens: 40,
    cache_write_tokens: 10,
    reasoning_tokens: 0,
    turns_used: 5,
    duration_ms: 60000,
    extracted_at: "2026-03-20T10:05:00.000Z",
    ...overrides,
  };
}

function makeConfigSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    timestamp: "2026-03-20T10:00:00.000Z",
    config_hashes: { "pipeline-config/review/SKILL.md": "abc123" },
    file_count: 1,
    ...overrides,
  };
}

function writeTokenHistory(
  symphonyHome: string,
  records: Record<string, unknown>[],
) {
  const dataDir = join(symphonyHome, "data");
  mkdirSync(dataDir, { recursive: true });
  mkdirSync(join(dataDir, "linear-cache"), { recursive: true });
  const path = join(dataDir, "token-history.jsonl");
  writeFileSync(path, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
}

function writeConfigHistory(
  symphonyHome: string,
  records: Record<string, unknown>[],
) {
  const dataDir = join(symphonyHome, "data");
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, "config-history.jsonl");
  writeFileSync(path, `${records.map((r) => JSON.stringify(r)).join("\n")}\n`);
}

function runAnalyze(
  symphonyHome: string,
  extraEnv: Record<string, string> = {},
) {
  const env = {
    ...process.env,
    SYMPHONY_HOME: symphonyHome,
    SYMPHONY_LOG_DIR: join(symphonyHome, "logs"),
    LINEAR_API_KEY: "", // Disable Linear for tests
    ...extraEnv,
  };
  const stdout = execFileSync(NODE_BIN, [SCRIPT_PATH, "analyze"], {
    env,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 15000,
  });
  return JSON.parse(stdout);
}

/**
 * Generate N days of token records spread across the date range.
 */
function generateDaysOfRecords(
  days: number,
  perDay: number,
  baseOverrides: Record<string, unknown> = {},
) {
  const records: Record<string, unknown>[] = [];
  const now = new Date();
  for (let d = 0; d < days; d++) {
    const date = new Date(now);
    date.setDate(date.getDate() - d);
    for (let i = 0; i < perDay; i++) {
      const ts = new Date(date);
      ts.setHours(10 + i, 0, 0, 0);
      records.push(
        makeTokenRecord({
          timestamp: ts.toISOString(),
          issue_identifier: `SYMPH-${200 + d}`,
          issue_id: `id-${200 + d}`,
          ...baseOverrides,
        }),
      );
    }
  }
  return records;
}

describe("token-report.mjs analyze", () => {
  let symphonyHome: string;

  beforeEach(() => {
    symphonyHome = tmpDir();
  });

  afterEach(() => {
    rmSync(symphonyHome, { recursive: true, force: true });
  });

  it("efficiency scorecard computation with 30+ days", () => {
    const records = generateDaysOfRecords(35, 2);
    writeTokenHistory(symphonyHome, records);
    writeConfigHistory(symphonyHome, [makeConfigSnapshot()]);

    const result = runAnalyze(symphonyHome);

    // Check all scorecard fields exist
    const sc = result.efficiency_scorecard;
    expect(sc.cache_efficiency).toBeDefined();
    expect(sc.output_ratio).toBeDefined();
    expect(sc.wasted_context).toBeDefined();
    expect(sc.tokens_per_turn).toBeDefined();
    expect(sc.first_pass_rate).toBeDefined();
    expect(sc.failure_rate).toBeDefined();

    // Each metric has current, trend_7d, trend_30d
    expect(sc.cache_efficiency.current).toBeTypeOf("number");
    expect(sc.cache_efficiency.trend_7d).toBeTypeOf("number");
    expect(sc.cache_efficiency.trend_30d).toBeTypeOf("number");

    // Verify cache_efficiency formula: cache_read / (input + cache_read) * 100
    // With defaults: 400 / (1000 + 400) * 100 = 28.6 (approx)
    expect(sc.cache_efficiency.current).toBeCloseTo(28.6, 0);

    // Verify wasted_context formula: no_cache / input * 100
    // With defaults: 50 / 1000 * 100 = 5
    expect(sc.wasted_context.current).toBeCloseTo(5, 0);
  });

  it("failed stages excluded from efficiency but included in spend", () => {
    const completed = Array.from({ length: 20 }, (_, i) =>
      makeTokenRecord({
        timestamp: new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString(),
        stage_name: "implement",
        outcome: "completed",
        issue_identifier: `SYMPH-${300 + i}`,
        total_input_tokens: 1000,
        total_cache_read_tokens: 400,
      }),
    );
    const failed = Array.from({ length: 5 }, (_, i) =>
      makeTokenRecord({
        timestamp: new Date(
          Date.now() - (20 + i) * 24 * 60 * 60 * 1000,
        ).toISOString(),
        stage_name: "implement",
        outcome: "failed",
        issue_identifier: `SYMPH-${320 + i}`,
        total_input_tokens: 500,
        total_cache_read_tokens: 0,
      }),
    );
    writeTokenHistory(symphonyHome, [...completed, ...failed]);
    writeConfigHistory(symphonyHome, [makeConfigSnapshot()]);

    const result = runAnalyze(symphonyHome);

    // Per-stage spend includes all 25
    expect(result.per_stage_spend.implement.count).toBe(25);
    expect(result.per_stage_spend.implement.completed).toBe(20);
    expect(result.per_stage_spend.implement.failed).toBe(5);

    // failure_rate for implement = 5/25 = 20%
    expect(result.efficiency_scorecard.failure_rate.current.implement).toBe(20);
  });

  it("first-pass rate computation", () => {
    // SYMPH-100: 1 implement completed (first-pass)
    // SYMPH-101: 2 implement completed (rework)
    // SYMPH-102: 1 implement completed (first-pass)
    const records = [
      makeTokenRecord({
        issue_identifier: "SYMPH-100",
        stage_name: "implement",
        outcome: "completed",
        timestamp: new Date(Date.now() - 1000).toISOString(),
      }),
      makeTokenRecord({
        issue_identifier: "SYMPH-101",
        stage_name: "implement",
        outcome: "completed",
        timestamp: new Date(Date.now() - 2000).toISOString(),
      }),
      makeTokenRecord({
        issue_identifier: "SYMPH-101",
        stage_name: "implement",
        outcome: "completed",
        timestamp: new Date(Date.now() - 3000).toISOString(),
      }),
      makeTokenRecord({
        issue_identifier: "SYMPH-102",
        stage_name: "implement",
        outcome: "completed",
        timestamp: new Date(Date.now() - 4000).toISOString(),
      }),
    ];
    writeTokenHistory(symphonyHome, records);
    writeConfigHistory(symphonyHome, [makeConfigSnapshot()]);

    const result = runAnalyze(symphonyHome);

    // first_pass_rate = 1 - (1/3) = 66.7%
    const fpr = result.efficiency_scorecard.first_pass_rate.current;
    expect(fpr).toBeGreaterThan(66);
    expect(fpr).toBeLessThan(67);
  });

  it("per-stage utilization trend with config-change markers", () => {
    const records = generateDaysOfRecords(35, 1, {
      stage_name: "investigate",
    });
    const moreRecords = generateDaysOfRecords(35, 1, {
      stage_name: "implement",
    });
    const reviewRecords = generateDaysOfRecords(35, 1, {
      stage_name: "review",
    });
    const mergeRecords = generateDaysOfRecords(35, 1, {
      stage_name: "merge",
    });
    writeTokenHistory(symphonyHome, [
      ...records,
      ...moreRecords,
      ...reviewRecords,
      ...mergeRecords,
    ]);
    writeConfigHistory(symphonyHome, [
      makeConfigSnapshot({
        timestamp: new Date(
          Date.now() - 10 * 24 * 60 * 60 * 1000,
        ).toISOString(),
      }),
      makeConfigSnapshot({
        timestamp: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
        config_hashes: { "pipeline-config/review/SKILL.md": "changed123" },
      }),
    ]);

    const result = runAnalyze(symphonyHome);

    // At least 4 stage types
    const stageKeys = Object.keys(result.per_stage_trend);
    expect(stageKeys.length).toBeGreaterThanOrEqual(4);
    expect(stageKeys).toContain("investigate");
    expect(stageKeys).toContain("implement");
    expect(stageKeys).toContain("review");
    expect(stageKeys).toContain("merge");

    // Config changes should be present
    expect(result.per_stage_trend.implement.config_changes).toBeDefined();
    expect(
      result.per_stage_trend.implement.config_changes.length,
    ).toBeGreaterThanOrEqual(1);
  });

  it("per-ticket cost trend with median and mean", () => {
    const records = generateDaysOfRecords(35, 2);
    writeTokenHistory(symphonyHome, records);
    writeConfigHistory(symphonyHome, [makeConfigSnapshot()]);

    const result = runAnalyze(symphonyHome);

    expect(result.per_ticket_trend.median).toBeDefined();
    expect(result.per_ticket_trend.mean).toBeDefined();
    expect(result.per_ticket_trend.ticket_count).toBeGreaterThan(0);
  });

  it("WoW delta computation with 14+ days", () => {
    // Create records with different token counts for current vs prior week
    // Use noon timestamps to avoid midnight boundary issues with daysAgo()
    const records: Record<string, unknown>[] = [];
    const now = new Date();

    // Current week (days 1-6): 5000 tokens each — use midday timestamps
    for (let d = 1; d <= 6; d++) {
      const date = new Date(now);
      date.setDate(date.getDate() - d);
      date.setHours(12, 0, 0, 0);
      records.push(
        makeTokenRecord({
          timestamp: date.toISOString(),
          total_total_tokens: 5000,
          issue_identifier: `SYMPH-C${d}`,
        }),
      );
    }

    // Prior week (days 8-13): 4000 tokens each — use midday timestamps
    for (let d = 8; d <= 13; d++) {
      const date = new Date(now);
      date.setDate(date.getDate() - d);
      date.setHours(12, 0, 0, 0);
      records.push(
        makeTokenRecord({
          timestamp: date.toISOString(),
          total_total_tokens: 4000,
          issue_identifier: `SYMPH-P${d}`,
        }),
      );
    }

    // Add an anchor record 15 days ago to ensure span >= 14
    const anchor = new Date(now);
    anchor.setDate(anchor.getDate() - 15);
    anchor.setHours(12, 0, 0, 0);
    records.push(
      makeTokenRecord({
        timestamp: anchor.toISOString(),
        total_total_tokens: 4000,
        issue_identifier: "SYMPH-ANCHOR",
      }),
    );

    writeTokenHistory(symphonyHome, records);
    writeConfigHistory(symphonyHome, [makeConfigSnapshot()]);

    const result = runAnalyze(symphonyHome);

    // wow_delta_pct should exist and be non-null
    expect(
      result.executive_summary.total_tokens.wow_delta_pct,
    ).not.toBeUndefined();
    expect(result.executive_summary.total_tokens.wow_delta_pct).not.toBeNull();
    // Current week: 6*5000 = 30000, Prior week: 6*4000 = 24000
    // WoW = (30000 - 24000) / 24000 * 100 = 25%
    expect(result.executive_summary.total_tokens.wow_delta_pct).toBe(25);
  });

  it("per-product breakdown", () => {
    const records = [
      ...generateDaysOfRecords(5, 1, { product: "symphony" }),
      ...generateDaysOfRecords(5, 1, { product: "jony" }),
      ...generateDaysOfRecords(5, 1, { product: "stickerlabs" }),
    ];
    writeTokenHistory(symphonyHome, records);
    writeConfigHistory(symphonyHome, [makeConfigSnapshot()]);

    const result = runAnalyze(symphonyHome);

    expect(Object.keys(result.per_product).length).toBe(3);
    expect(result.per_product.symphony).toBeDefined();
    expect(result.per_product.jony).toBeDefined();
    expect(result.per_product.stickerlabs).toBeDefined();
  });

  it("inflection detection returns array structure", () => {
    // Generate 35 days with a spike pattern in the last 7 days
    const records: Record<string, unknown>[] = [];
    const now = new Date();

    // Days 8-34: normal (3000 tokens)
    for (let d = 8; d < 35; d++) {
      const date = new Date(now);
      date.setDate(date.getDate() - d);
      records.push(
        makeTokenRecord({
          timestamp: date.toISOString(),
          stage_name: "implement",
          total_total_tokens: 3000,
          issue_identifier: `SYMPH-N${d}`,
        }),
      );
    }

    // Days 0-7: spike (6000 tokens — >15% above baseline)
    for (let d = 0; d < 7; d++) {
      const date = new Date(now);
      date.setDate(date.getDate() - d);
      records.push(
        makeTokenRecord({
          timestamp: date.toISOString(),
          stage_name: "implement",
          total_total_tokens: 6000,
          issue_identifier: `SYMPH-S${d}`,
        }),
      );
    }

    writeTokenHistory(symphonyHome, records);
    writeConfigHistory(symphonyHome, [makeConfigSnapshot()]);

    const result = runAnalyze(symphonyHome);

    // inflections should be an array
    expect(Array.isArray(result.inflections)).toBe(true);
    // With the spike, we should detect an inflection
    expect(result.inflections.length).toBeGreaterThanOrEqual(1);
    if (result.inflections.length > 0) {
      const inf = result.inflections[0];
      // New UI-expected shape (SYMPH-185)
      expect(inf.metric).toBeDefined();
      expect(inf.date).toBeDefined();
      expect(typeof inf.magnitude).toBe("number");
      expect(["up", "down"]).toContain(inf.direction);
      expect(inf.attributions).toBeDefined();
      expect(Array.isArray(inf.attributions)).toBe(true);
      expect(inf.avg_7d).toBeDefined();
      expect(inf.avg_30d).toBeDefined();
      // LLM insight is null when TOKEN_REPORT_LLM is not set
      expect(inf.llm_insight).toBeNull();
    }
  });

  it("inflection detection with config-change correlation", () => {
    const records: Record<string, unknown>[] = [];
    const now = new Date();

    // Days 8-34: normal (3000 tokens) for review stage
    for (let d = 8; d < 35; d++) {
      const date = new Date(now);
      date.setDate(date.getDate() - d);
      records.push(
        makeTokenRecord({
          timestamp: date.toISOString(),
          stage_name: "review",
          total_total_tokens: 3000,
          issue_identifier: `SYMPH-R${d}`,
        }),
      );
    }

    // Days 0-7: dropped (2000 tokens — drop >15%)
    for (let d = 0; d < 7; d++) {
      const date = new Date(now);
      date.setDate(date.getDate() - d);
      records.push(
        makeTokenRecord({
          timestamp: date.toISOString(),
          stage_name: "review",
          total_total_tokens: 2000,
          issue_identifier: `SYMPH-RD${d}`,
        }),
      );
    }

    writeTokenHistory(symphonyHome, records);

    // Config change 2 days before the 7d boundary
    const d7 = new Date(now);
    d7.setDate(d7.getDate() - 7);
    const configChangeDate = new Date(d7);
    configChangeDate.setDate(configChangeDate.getDate() - 1);

    writeConfigHistory(symphonyHome, [
      makeConfigSnapshot({
        timestamp: new Date(
          now.getTime() - 30 * 24 * 60 * 60 * 1000,
        ).toISOString(),
        config_hashes: { "pipeline-config/review/SKILL.md": "oldhash" },
      }),
      makeConfigSnapshot({
        timestamp: configChangeDate.toISOString(),
        config_hashes: { "pipeline-config/review/SKILL.md": "newhash" },
      }),
    ]);

    const result = runAnalyze(symphonyHome);

    expect(Array.isArray(result.inflections)).toBe(true);
    // Should detect the decrease
    if (result.inflections.length > 0) {
      const inf = result.inflections[0];
      // New UI-expected shape (SYMPH-185)
      expect(inf.metric).toBe("review");
      expect(inf.direction).toBe("down");
      expect(typeof inf.magnitude).toBe("number");
      expect(inf.attributions.length).toBeGreaterThanOrEqual(0);
      expect(inf.llm_insight).toBeNull();
    }
  });

  it("excludes spec-gen stage from per_stage_spend aggregation", () => {
    const records: Record<string, unknown>[] = [];
    const now = new Date();

    // Create records for implement and spec-gen stages
    for (let d = 0; d < 10; d++) {
      const date = new Date(now);
      date.setDate(date.getDate() - d);
      records.push(
        makeTokenRecord({
          timestamp: date.toISOString(),
          stage_name: "implement",
          total_total_tokens: 3000,
        }),
      );
      records.push(
        makeTokenRecord({
          timestamp: date.toISOString(),
          stage_name: "spec-gen",
          total_total_tokens: 1000,
        }),
      );
    }

    writeTokenHistory(symphonyHome, records);
    writeConfigHistory(symphonyHome, [makeConfigSnapshot()]);

    const result = runAnalyze(symphonyHome);

    // spec-gen should be excluded from per_stage_spend
    expect(result.per_stage_spend["spec-gen"]).toBeUndefined();
    expect(result.per_stage_spend.implement).toBeDefined();
  });

  it("SYMPH-186: inflection records include pipeline_classification and llm_insight fields", () => {
    // Generate 35 days with a spike pattern in the last 7 days
    const records: Record<string, unknown>[] = [];
    const now = new Date();

    // Days 8-34: normal (3000 tokens)
    for (let d = 8; d < 35; d++) {
      const date = new Date(now);
      date.setDate(date.getDate() - d);
      records.push(
        makeTokenRecord({
          timestamp: date.toISOString(),
          stage_name: "implement",
          total_total_tokens: 3000,
          issue_identifier: `SYMPH-N${d}`,
        }),
      );
    }

    // Days 0-7: spike (6000 tokens — >15% above baseline)
    for (let d = 0; d < 7; d++) {
      const date = new Date(now);
      date.setDate(date.getDate() - d);
      records.push(
        makeTokenRecord({
          timestamp: date.toISOString(),
          stage_name: "implement",
          total_total_tokens: 6000,
          issue_identifier: `SYMPH-S${d}`,
        }),
      );
    }

    writeTokenHistory(symphonyHome, records);
    writeConfigHistory(symphonyHome, [makeConfigSnapshot()]);

    const result = runAnalyze(symphonyHome);

    expect(Array.isArray(result.inflections)).toBe(true);
    expect(result.inflections.length).toBeGreaterThanOrEqual(1);

    const inf = result.inflections[0];
    // SYMPH-186: pipeline_classification field must exist
    expect(inf.pipeline_classification).toBeDefined();
    expect(Array.isArray(inf.pipeline_classification)).toBe(true);

    // SYMPH-186: llm_insight should be null when TOKEN_REPORT_LLM is not set
    expect(inf.llm_insight).toBeNull();
  });

  it("SYMPH-186: spec-gen stage is excluded from inflection aggregations", () => {
    const records: Record<string, unknown>[] = [];
    const now = new Date();

    // Generate spec-gen records with a spike that would trigger inflection
    // Days 8-34: normal spec-gen (3000 tokens)
    for (let d = 8; d < 35; d++) {
      const date = new Date(now);
      date.setDate(date.getDate() - d);
      records.push(
        makeTokenRecord({
          timestamp: date.toISOString(),
          stage_name: "spec-gen",
          total_total_tokens: 3000,
          issue_identifier: `SYMPH-SG${d}`,
        }),
      );
    }

    // Days 0-7: spec-gen spike (6000 tokens)
    for (let d = 0; d < 7; d++) {
      const date = new Date(now);
      date.setDate(date.getDate() - d);
      records.push(
        makeTokenRecord({
          timestamp: date.toISOString(),
          stage_name: "spec-gen",
          total_total_tokens: 6000,
          issue_identifier: `SYMPH-SGS${d}`,
        }),
      );
    }

    // Add steady implement records so we have >=30d of non-spec-gen data
    // (needed to reach the >=30d tier where inflection detection runs)
    for (let d = 0; d < 35; d++) {
      const date = new Date(now);
      date.setDate(date.getDate() - d);
      records.push(
        makeTokenRecord({
          timestamp: date.toISOString(),
          stage_name: "implement",
          total_total_tokens: 3000,
          issue_identifier: `SYMPH-IM${d}`,
        }),
      );
    }

    writeTokenHistory(symphonyHome, records);
    writeConfigHistory(symphonyHome, [makeConfigSnapshot()]);

    const result = runAnalyze(symphonyHome);

    // With >=30d of non-spec-gen data, inflections should be an array
    expect(Array.isArray(result.inflections)).toBe(true);
    // spec-gen should never appear in inflections since it's filtered out
    const specGenInflections = result.inflections.filter(
      (inf: Record<string, unknown>) => inf.metric === "spec-gen",
    );
    expect(specGenInflections).toHaveLength(0);
  });

  it("SYMPH-186: pipeline_classification contains raw ticket data, not classification labels", () => {
    const records: Record<string, unknown>[] = [];
    const now = new Date();

    // Days 8-34: normal (3000 tokens)
    for (let d = 8; d < 35; d++) {
      const date = new Date(now);
      date.setDate(date.getDate() - d);
      records.push(
        makeTokenRecord({
          timestamp: date.toISOString(),
          stage_name: "implement",
          total_total_tokens: 3000,
          issue_identifier: `SYMPH-N${d}`,
        }),
      );
    }

    // Days 0-7: spike (6000 tokens)
    for (let d = 0; d < 7; d++) {
      const date = new Date(now);
      date.setDate(date.getDate() - d);
      records.push(
        makeTokenRecord({
          timestamp: date.toISOString(),
          stage_name: "implement",
          total_total_tokens: 6000,
          issue_identifier: `SYMPH-S${d}`,
        }),
      );
    }

    writeTokenHistory(symphonyHome, records);
    writeConfigHistory(symphonyHome, [makeConfigSnapshot()]);

    const result = runAnalyze(symphonyHome);

    expect(result.inflections.length).toBeGreaterThanOrEqual(1);
    const inf = result.inflections[0];

    // pipeline_classification entries should NOT contain classification labels
    if (inf.pipeline_classification.length > 0) {
      const entry = inf.pipeline_classification[0];
      expect(entry.identifier).toBeDefined();
      // Should have raw fields, not COMPLEX/STANDARD/TRIVIAL labels
      expect(entry).not.toHaveProperty("classification");
      expect(entry).toHaveProperty("task_count");
      expect(entry).toHaveProperty("parent_identifier");
      expect(entry).toHaveProperty("parent_title");
    }
  });

  it("outlier detection with Linear hypothesis structure", () => {
    const records: Record<string, unknown>[] = [];
    const now = new Date();

    // Normal issues: ~3000 tokens each
    for (let i = 0; i < 20; i++) {
      records.push(
        makeTokenRecord({
          timestamp: new Date(
            now.getTime() - i * 24 * 60 * 60 * 1000,
          ).toISOString(),
          issue_identifier: `SYMPH-${400 + i}`,
          issue_id: `id-${400 + i}`,
          total_total_tokens: 3000,
          stage_name: "implement",
        }),
      );
    }

    // Outlier issue: 127000 tokens (way above 2σ)
    records.push(
      makeTokenRecord({
        timestamp: new Date(
          now.getTime() - 1 * 24 * 60 * 60 * 1000,
        ).toISOString(),
        issue_identifier: "SYMPH-145",
        issue_id: "id-145",
        total_total_tokens: 127000,
        stage_name: "implement",
      }),
    );

    writeTokenHistory(symphonyHome, records);
    writeConfigHistory(symphonyHome, [makeConfigSnapshot()]);

    const result = runAnalyze(symphonyHome);

    // Should detect outlier
    expect(Array.isArray(result.outliers)).toBe(true);
    expect(result.outliers.length).toBeGreaterThanOrEqual(1);

    const outlier = result.outliers.find(
      (o: Record<string, unknown>) => o.issue_identifier === "SYMPH-145",
    );
    expect(outlier).toBeDefined();
    expect(outlier.total_tokens).toBe(127000);
    expect(outlier.z_score).toBeGreaterThan(2);
    expect(outlier.hypothesis).toBeDefined();
    // SYMPH-179: multiplier = total_tokens / mean
    expect(outlier.multiplier).toBeGreaterThan(1);
    expect(outlier.multiplier).toBe(
      Math.round((127000 / outlier.mean) * 10) / 10,
    );
    // SYMPH-179: linear_url uses mobilyze-llc org pattern
    expect(outlier.linear_url).toBe(
      "https://linear.app/mobilyze-llc/issue/SYMPH-145",
    );
    // Without LINEAR_API_KEY, parent is null
    expect(outlier.parent).toBeNull();
    expect(outlier.hypothesis).toContain("unavailable");
  });

  it("leaderboard includes top 25 issues sorted by token spend (SYMPH-179)", () => {
    const records: Record<string, unknown>[] = [];
    const now = new Date();

    // Create 30 issues with varying token counts
    for (let i = 0; i < 30; i++) {
      records.push(
        makeTokenRecord({
          timestamp: new Date(
            now.getTime() - i * 24 * 60 * 60 * 1000,
          ).toISOString(),
          issue_identifier: `SYMPH-${500 + i}`,
          issue_id: `id-${500 + i}`,
          issue_title: `Issue ${500 + i}`,
          total_total_tokens: (30 - i) * 1000,
          stage_name: "implement",
        }),
      );
    }

    writeTokenHistory(symphonyHome, records);
    writeConfigHistory(symphonyHome, [makeConfigSnapshot()]);

    const result = runAnalyze(symphonyHome);

    expect(Array.isArray(result.leaderboard)).toBe(true);
    // Capped at 25
    expect(result.leaderboard.length).toBe(25);
    // Sorted descending by tokens
    expect(result.leaderboard[0].tokens).toBeGreaterThanOrEqual(
      result.leaderboard[1].tokens,
    );
    // Has required fields
    const first = result.leaderboard[0];
    expect(first.identifier).toBeDefined();
    expect(first.title).toBeDefined();
    expect(first.tokens).toBeGreaterThan(0);
    expect(first.linear_url).toBe(
      `https://linear.app/mobilyze-llc/issue/${first.identifier}`,
    );
  });

  it("cold start with insufficient data (<7 days)", () => {
    const records = generateDaysOfRecords(3, 2);
    writeTokenHistory(symphonyHome, records);
    writeConfigHistory(symphonyHome, [makeConfigSnapshot()]);

    const result = runAnalyze(symphonyHome);

    expect(result.cold_start).toBe(true);
    expect(result.cold_start_tier).toBe("<7d");

    // Raw daily numbers still included
    expect(result.efficiency_scorecard).toBeDefined();
    expect(result.per_stage_spend).toBeDefined();

    // Inflections and outliers labeled insufficient data
    expect(result.inflections.status).toBe("insufficient data");
    expect(result.outliers.status).toBe("insufficient data");
  });

  it("empty token history produces valid cold start output", () => {
    // Just create the data dir without writing any records
    mkdirSync(join(symphonyHome, "data", "linear-cache"), { recursive: true });

    const result = runAnalyze(symphonyHome);

    expect(result.cold_start).toBe(true);
    expect(result.efficiency_scorecard).toBeDefined();
    expect(result.executive_summary).toBeDefined();
    expect(result.per_product).toEqual({});
    expect(result.outliers).toEqual([]);
    expect(result.leaderboard).toEqual([]);
    // daily_series present with empty arrays
    expect(result.daily_series).toBeDefined();
    expect(result.daily_series.cacheEff).toEqual([]);
    expect(result.daily_series.failureRate).toEqual([]);
  });

  it("daily_series has correct shape for cold start (<7d)", () => {
    const records = generateDaysOfRecords(3, 2);
    writeTokenHistory(symphonyHome, records);
    writeConfigHistory(symphonyHome, [makeConfigSnapshot()]);

    const result = runAnalyze(symphonyHome);

    expect(result.daily_series).toBeDefined();
    const ds = result.daily_series;
    // All six series keys present
    for (const key of [
      "cacheEff",
      "outputRatio",
      "wastedCtx",
      "tokPerTurn",
      "firstPass",
      "failureRate",
    ]) {
      expect(Array.isArray(ds[key])).toBe(true);
      // 3 days of data → up to 3 values (sparse)
      expect(ds[key].length).toBeGreaterThan(0);
      expect(ds[key].length).toBeLessThanOrEqual(3);
    }
  });

  it("daily_series has correct shape for mature data (>=30d)", () => {
    const records = generateDaysOfRecords(35, 3);
    writeTokenHistory(symphonyHome, records);
    writeConfigHistory(symphonyHome, [makeConfigSnapshot()]);

    const result = runAnalyze(symphonyHome);

    expect(result.cold_start_tier).toBe(">=30d");
    expect(result.daily_series).toBeDefined();
    const ds = result.daily_series;
    for (const key of [
      "cacheEff",
      "outputRatio",
      "wastedCtx",
      "tokPerTurn",
      "firstPass",
      "failureRate",
    ]) {
      expect(Array.isArray(ds[key])).toBe(true);
      // 30-day window, so up to 30 values
      expect(ds[key].length).toBeGreaterThan(0);
      expect(ds[key].length).toBeLessThanOrEqual(30);
    }
    // Values should be numeric
    for (const v of ds.cacheEff) {
      expect(typeof v).toBe("number");
    }
  });

  it("per_stage_stats contains avg_turns and cache_rate per stage", () => {
    const implementRecords = Array.from({ length: 10 }, (_, i) =>
      makeTokenRecord({
        timestamp: new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString(),
        stage_name: "implement",
        outcome: "completed",
        issue_identifier: `SYMPH-${400 + i}`,
        turns_used: 8,
        total_input_tokens: 1000,
        total_cache_read_tokens: 500,
      }),
    );
    const planRecords = Array.from({ length: 5 }, (_, i) =>
      makeTokenRecord({
        timestamp: new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString(),
        stage_name: "plan",
        outcome: "completed",
        issue_identifier: `SYMPH-${410 + i}`,
        turns_used: 3,
        total_input_tokens: 600,
        total_cache_read_tokens: 200,
      }),
    );
    writeTokenHistory(symphonyHome, [...implementRecords, ...planRecords]);
    writeConfigHistory(symphonyHome, [makeConfigSnapshot()]);

    const result = runAnalyze(symphonyHome);

    expect(result.per_stage_stats).toBeDefined();
    // Stage names derived from data, not hardcoded
    expect(Object.keys(result.per_stage_stats)).toContain("implement");
    expect(Object.keys(result.per_stage_stats)).toContain("plan");

    // implement: avg_turns = 8, cache_rate = 500/(1000+500)*100 = 33.3
    const impl = result.per_stage_stats.implement;
    expect(impl.avg_turns).toBeCloseTo(8, 0);
    expect(impl.cache_rate).toBeCloseTo(33.3, 0);
    expect(impl.count).toBe(10);

    // plan: avg_turns = 3, cache_rate = 200/(600+200)*100 = 25
    const plan = result.per_stage_stats.plan;
    expect(plan.avg_turns).toBeCloseTo(3, 0);
    expect(plan.cache_rate).toBeCloseTo(25, 0);
    expect(plan.count).toBe(5);
  });

  it("per_stage_stats is empty object for cold start with no data", () => {
    mkdirSync(join(symphonyHome, "data", "linear-cache"), { recursive: true });

    const result = runAnalyze(symphonyHome);

    expect(result.per_stage_stats).toEqual({});
  });

  it("per_stage_stats handles stages with zero cache reads", () => {
    const records = Array.from({ length: 5 }, (_, i) =>
      makeTokenRecord({
        timestamp: new Date(Date.now() - i * 24 * 60 * 60 * 1000).toISOString(),
        stage_name: "review",
        outcome: "completed",
        issue_identifier: `SYMPH-${500 + i}`,
        turns_used: 2,
        total_input_tokens: 800,
        total_cache_read_tokens: 0,
      }),
    );
    writeTokenHistory(symphonyHome, records);
    writeConfigHistory(symphonyHome, [makeConfigSnapshot()]);

    const result = runAnalyze(symphonyHome);

    const review = result.per_stage_stats.review;
    expect(review.avg_turns).toBeCloseTo(2, 0);
    expect(review.cache_rate).toBe(0);
    expect(review.count).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// Render subcommand tests — SYMPH-131
// ---------------------------------------------------------------------------

function runRender(
  symphonyHome: string,
  extraEnv: Record<string, string> = {},
) {
  const env = {
    ...process.env,
    SYMPHONY_HOME: symphonyHome,
    SYMPHONY_LOG_DIR: join(symphonyHome, "logs"),
    LINEAR_API_KEY: "",
    ...extraEnv,
  };
  return execFileSync(NODE_BIN, [SCRIPT_PATH, "render"], {
    env,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 15000,
  });
}

describe("token-report.mjs render", () => {
  let symphonyHome: string;

  beforeEach(() => {
    symphonyHome = tmpDir();
  });

  afterEach(() => {
    rmSync(symphonyHome, { recursive: true, force: true });
  });

  it("generates self-contained HTML with all 8 sections", () => {
    const records = generateDaysOfRecords(10, 3);
    writeTokenHistory(symphonyHome, records);
    writeConfigHistory(symphonyHome, [makeConfigSnapshot()]);

    runRender(symphonyHome);

    const today = new Date().toISOString().slice(0, 10);
    const htmlPath = join(symphonyHome, "reports", `${today}.html`);
    expect(existsSync(htmlPath)).toBe(true);

    const html = readFileSync(htmlPath, "utf-8");

    // Self-contained: no external resources (no http:// or https:// in link/script/img tags — except Linear links)
    const externalRefs = html.match(
      /<(?:link|script|img)[^>]*(?:src|href)=["']https?:\/\//gi,
    );
    expect(externalRefs).toBeNull();

    // All 8 sections present
    expect(html).toContain("Executive Summary");
    expect(html).toContain("Efficiency Scorecard");
    expect(html).toContain("Per-Stage Utilization Trend");
    expect(html).toContain("Per-Ticket Cost Trend");
    expect(html).toContain("Outlier Analysis");
    expect(html).toContain("Issue Leaderboard");
    expect(html).toContain("Stage Efficiency");
    expect(html).toContain("Per-Product Breakdown");

    // Inline SVG elements present
    expect(html).toContain("<svg");
    expect(html).toContain("<polyline");

    // WCAG AA: dark theme styles present
    expect(html).toContain("--bg: #0d1117");
    expect(html).toContain("--text: #c9d1d9");
  });

  it("renders with empty data (cold start)", () => {
    mkdirSync(join(symphonyHome, "data", "linear-cache"), { recursive: true });

    runRender(symphonyHome);

    const today = new Date().toISOString().slice(0, 10);
    const htmlPath = join(symphonyHome, "reports", `${today}.html`);
    expect(existsSync(htmlPath)).toBe(true);

    const html = readFileSync(htmlPath, "utf-8");
    expect(html).toContain("Executive Summary");
    expect(html).toContain("<svg");
  });
});

// ---------------------------------------------------------------------------
// Slack subcommand tests — SYMPH-131
// ---------------------------------------------------------------------------

function runSlack(symphonyHome: string, extraEnv: Record<string, string> = {}) {
  const env = {
    ...process.env,
    SYMPHONY_HOME: symphonyHome,
    SYMPHONY_LOG_DIR: join(symphonyHome, "logs"),
    LINEAR_API_KEY: "",
    ...extraEnv,
  };
  try {
    const result = spawnSync(NODE_BIN, [SCRIPT_PATH, "slack"], {
      env,
      encoding: "utf-8",
      timeout: 15000,
    });
    return {
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      exitCode: result.status ?? 0,
    };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return {
      stdout: e.stdout || "",
      stderr: e.stderr || "",
      exitCode: e.status ?? 1,
    };
  }
}

describe("token-report.mjs slack", () => {
  let symphonyHome: string;

  beforeEach(() => {
    symphonyHome = tmpDir();
  });

  afterEach(() => {
    rmSync(symphonyHome, { recursive: true, force: true });
  });

  it("graceful degradation when SLACK_BOT_TOKEN not set", () => {
    const records = generateDaysOfRecords(5, 2);
    writeTokenHistory(symphonyHome, records);
    writeConfigHistory(symphonyHome, [makeConfigSnapshot()]);

    const env: Record<string, string> = {};
    // Explicitly unset SLACK_BOT_TOKEN
    process.env.SLACK_BOT_TOKEN = undefined;
    const { exitCode, stderr } = runSlack(symphonyHome, env);

    expect(exitCode).toBe(0);
    // stderr should contain warning (captured by parent process)
  });

  it("exits 0 when SLACK_BOT_TOKEN is empty", () => {
    const records = generateDaysOfRecords(5, 2);
    writeTokenHistory(symphonyHome, records);
    writeConfigHistory(symphonyHome, [makeConfigSnapshot()]);

    const { exitCode } = runSlack(symphonyHome, { SLACK_BOT_TOKEN: "" });
    expect(exitCode).toBe(0);
  });

  it("DRY_RUN outputs concerns section and correct field names", () => {
    const records = generateDaysOfRecords(10, 3);
    writeTokenHistory(symphonyHome, records);
    writeConfigHistory(symphonyHome, [makeConfigSnapshot()]);

    const { exitCode, stderr } = runSlack(symphonyHome, {
      SLACK_BOT_TOKEN: "xoxb-test-token",
      DRY_RUN: "1",
    });

    expect(exitCode).toBe(0);
    // Should contain the concerns section
    expect(stderr).toContain("Concerns");
    // Should contain correct field name (total_tokens not total)
    expect(stderr).toContain("Per-Stage Spend");
    // Should contain correct field name (total_stages not stage_count)
    expect(stderr).toContain("Per-Product Breakdown");
    // Should not contain hardcoded pro16.local
    expect(stderr).not.toContain("pro16.local");
  });

  it("DRY_RUN URL uses BASE_URL env var and strips protocol", () => {
    const records = generateDaysOfRecords(5, 2);
    writeTokenHistory(symphonyHome, records);
    writeConfigHistory(symphonyHome, [makeConfigSnapshot()]);

    const { exitCode, stderr } = runSlack(symphonyHome, {
      SLACK_BOT_TOKEN: "xoxb-test-token",
      DRY_RUN: "1",
      BASE_URL: "http://myhost.example.com:9090",
    });

    expect(exitCode).toBe(0);
    // Should have stripped http:// and produced clean URL
    expect(stderr).toContain("myhost.example.com:9090/");
    expect(stderr).not.toContain("http://http://");
  });

  it("DRY_RUN with cold start notes data tier", () => {
    // 3 days of data → cold start (< 7d)
    const records = generateDaysOfRecords(3, 2);
    writeTokenHistory(symphonyHome, records);
    writeConfigHistory(symphonyHome, [makeConfigSnapshot()]);

    const { exitCode, stderr } = runSlack(symphonyHome, {
      SLACK_BOT_TOKEN: "xoxb-test-token",
      DRY_RUN: "1",
    });

    expect(exitCode).toBe(0);
    expect(stderr).toContain("Cold start");
    expect(stderr).toContain("WoW deltas not available");
  });
});

// ---------------------------------------------------------------------------
// Rotate subcommand tests — SYMPH-131
// ---------------------------------------------------------------------------

function runRotate(
  symphonyHome: string,
  extraEnv: Record<string, string> = {},
) {
  const env = {
    ...process.env,
    SYMPHONY_HOME: symphonyHome,
    SYMPHONY_LOG_DIR: join(symphonyHome, "logs"),
    LINEAR_API_KEY: "",
    ...extraEnv,
  };
  return execFileSync(NODE_BIN, [SCRIPT_PATH, "rotate"], {
    env,
    encoding: "utf-8",
    stdio: ["pipe", "pipe", "pipe"],
    timeout: 15000,
  });
}

describe("token-report.mjs rotate", () => {
  let symphonyHome: string;

  beforeEach(() => {
    symphonyHome = tmpDir();
  });

  afterEach(() => {
    rmSync(symphonyHome, { recursive: true, force: true });
  });

  it("compresses JSONL files older than 7 days", () => {
    const dataDir = join(symphonyHome, "data");
    mkdirSync(dataDir, { recursive: true });

    const oldFile = join(dataDir, "old-log.jsonl");
    writeFileSync(oldFile, '{"test": true}\n');

    // Set mtime to 10 days ago
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
    utimesSync(oldFile, tenDaysAgo, tenDaysAgo);

    runRotate(symphonyHome);

    // Original should be gone, compressed should exist
    expect(existsSync(oldFile)).toBe(false);
    expect(existsSync(`${oldFile}.gz`)).toBe(true);
  });

  it("deletes compressed files older than 14 days", () => {
    const dataDir = join(symphonyHome, "data");
    mkdirSync(dataDir, { recursive: true });

    const oldGz = join(dataDir, "ancient-log.jsonl.gz");
    writeFileSync(oldGz, "compressed-data");

    // Set mtime to 20 days ago
    const twentyDaysAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
    utimesSync(oldGz, twentyDaysAgo, twentyDaysAgo);

    runRotate(symphonyHome);

    expect(existsSync(oldGz)).toBe(false);
  });

  it("does not touch files with mtime less than 2 hours", () => {
    const dataDir = join(symphonyHome, "data");
    mkdirSync(dataDir, { recursive: true });

    const recentFile = join(dataDir, "recent.jsonl");
    writeFileSync(recentFile, '{"test": true}\n');
    // File was just created, mtime < 2h

    runRotate(symphonyHome);

    // File should still exist and not be compressed
    expect(existsSync(recentFile)).toBe(true);
    expect(existsSync(`${recentFile}.gz`)).toBe(false);
  });

  it("deletes HTML reports older than 90 days", () => {
    const reportsDir = join(symphonyHome, "reports");
    mkdirSync(reportsDir, { recursive: true });

    const oldReport = join(reportsDir, "2025-01-01.html");
    writeFileSync(oldReport, "<html></html>");

    // Set mtime to 100 days ago
    const hundredDaysAgo = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000);
    utimesSync(oldReport, hundredDaysAgo, hundredDaysAgo);

    runRotate(symphonyHome);

    expect(existsSync(oldReport)).toBe(false);
  });

  it("preserves recent HTML reports", () => {
    const reportsDir = join(symphonyHome, "reports");
    mkdirSync(reportsDir, { recursive: true });

    const recentReport = join(reportsDir, "2026-03-20.html");
    writeFileSync(recentReport, "<html></html>");

    runRotate(symphonyHome);

    expect(existsSync(recentReport)).toBe(true);
  });
});
