#!/usr/bin/env node
/**
 * token-report.mjs — Token history extraction, analysis, HTML reports, Slack digest, log rotation
 *
 * Subcommands:
 *   extract  — Parse symphony.jsonl logs, extract stage_completed events,
 *              enrich with Linear issue titles, append to token-history.jsonl (SYMPH-129)
 *   analyze  — Compute efficiency metrics, trends, outliers from token-history.jsonl (SYMPH-130)
 *   render   — Generate self-contained HTML report with inline SVG charts (SYMPH-131)
 *   slack    — Post ≤15-line digest via $SLACK_BOT_TOKEN (SYMPH-131)
 *   rotate   — Compress/delete old logs and reports (SYMPH-131)
 *
 * Environment:
 *   SYMPHONY_HOME      (default $HOME/.symphony)
 *   SYMPHONY_LOG_DIR   (default $HOME/Library/Logs/symphony)
 *   LINEAR_API_KEY     — used by `linear` CLI; graceful degradation without it
 *   SLACK_BOT_TOKEN    — Slack bot token; graceful degradation without it
 *   BASE_URL           — hostname:port for report links (never hardcode localhost)
 *   TOKEN_REPORT_PORT  — port for report server (default 8090)
 *
 * SYMPH-129, SYMPH-130, SYMPH-131
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const SYMPHONY_HOME = process.env.SYMPHONY_HOME || join(homedir(), ".symphony");
const SYMPHONY_LOG_DIR =
  process.env.SYMPHONY_LOG_DIR ||
  join(homedir(), "Library", "Logs", "symphony");

const DATA_DIR = join(SYMPHONY_HOME, "data");
const HWM_DIR = join(DATA_DIR, ".hwm");
const LINEAR_CACHE_DIR = join(DATA_DIR, "linear-cache");
const TOKEN_HISTORY_PATH = join(DATA_DIR, "token-history.jsonl");
const CONFIG_HISTORY_PATH = join(DATA_DIR, "config-history.jsonl");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function warn(msg) {
  process.stderr.write(`WARN: ${msg}\n`);
}

function info(msg) {
  process.stderr.write(`INFO: ${msg}\n`);
}

/**
 * Compute a safe filename key for an HWM file from an absolute log path.
 */
function hwmKeyForPath(logPath) {
  return createHash("sha256").update(logPath).digest("hex").slice(0, 16);
}

/**
 * Read HWM state for a log file. Returns { inode, offset }.
 */
function readHwm(logPath) {
  const hwmFile = join(HWM_DIR, `${hwmKeyForPath(logPath)}.json`);
  if (!existsSync(hwmFile)) return { inode: 0, offset: 0 };
  try {
    return JSON.parse(readFileSync(hwmFile, "utf-8"));
  } catch {
    return { inode: 0, offset: 0 };
  }
}

/**
 * Write HWM state for a log file.
 */
function writeHwm(logPath, state) {
  const hwmFile = join(HWM_DIR, `${hwmKeyForPath(logPath)}.json`);
  writeFileSync(hwmFile, `${JSON.stringify(state)}\n`);
}

/**
 * Get inode of a file (cross-platform).
 */
function getInode(filePath) {
  try {
    return statSync(filePath).ino;
  } catch {
    return 0;
  }
}

/**
 * Get file size.
 */
function getFileSize(filePath) {
  try {
    return statSync(filePath).size;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Log reading — inode-aware, truncation-aware, partial-line-safe
// ---------------------------------------------------------------------------

/**
 * Read new complete lines from a log file starting from the HWM.
 * Returns { lines: string[], newOffset: number, newInode: number }.
 */
function readNewLines(logPath) {
  const hwm = readHwm(logPath);
  const currentInode = getInode(logPath);
  const currentSize = getFileSize(logPath);

  if (currentSize === 0) {
    return { lines: [], newOffset: 0, newInode: currentInode };
  }

  let startOffset = hwm.offset;

  // Inode change → log rotation → reset to beginning
  if (currentInode !== hwm.inode && hwm.inode !== 0) {
    info(
      `Inode changed for ${logPath} (${hwm.inode} → ${currentInode}), resetting HWM`,
    );
    startOffset = 0;
  }

  // File truncated → reset to beginning
  if (currentSize < startOffset) {
    info(
      `File truncated for ${logPath} (size ${currentSize} < offset ${startOffset}), resetting HWM`,
    );
    startOffset = 0;
  }

  // Nothing new to read
  if (startOffset >= currentSize) {
    return { lines: [], newOffset: startOffset, newInode: currentInode };
  }

  // Read the new bytes
  const bytesToRead = currentSize - startOffset;
  const buf = Buffer.alloc(bytesToRead);
  const fd = openSync(logPath, "r");
  try {
    readSync(fd, buf, 0, bytesToRead, startOffset);
  } finally {
    closeSync(fd);
  }

  const raw = buf.toString("utf-8");

  // Find last newline — everything after it is a partial line to discard
  const lastNewline = raw.lastIndexOf("\n");
  if (lastNewline === -1) {
    // No complete line at all — keep offset where it was
    return { lines: [], newOffset: startOffset, newInode: currentInode };
  }

  const completeText = raw.slice(0, lastNewline);
  const lines = completeText.split("\n").filter((l) => l.trim().length > 0);
  const newOffset = startOffset + lastNewline + 1;

  return { lines, newOffset, newInode: currentInode };
}

// ---------------------------------------------------------------------------
// Linear CLI integration
// ---------------------------------------------------------------------------

let linearAvailable = null; // tri-state: null=unknown, true, false

function checkLinearAvailable() {
  if (linearAvailable !== null) return linearAvailable;
  if (!process.env.LINEAR_API_KEY) {
    warn("LINEAR_API_KEY not set — issue titles will be null");
    linearAvailable = false;
    return false;
  }
  try {
    execFileSync("which", ["linear"], { stdio: "pipe" });
    linearAvailable = true;
  } catch {
    warn("linear CLI not found in PATH — issue titles will be null");
    linearAvailable = false;
  }
  return linearAvailable;
}

/**
 * Look up a Linear issue title, with filesystem cache.
 * Returns the title string or null.
 */
function getLinearTitle(issueIdentifier) {
  if (!issueIdentifier) return null;

  // Check cache first
  const cacheFile = join(LINEAR_CACHE_DIR, `${issueIdentifier}.json`);
  if (existsSync(cacheFile)) {
    try {
      const cached = JSON.parse(readFileSync(cacheFile, "utf-8"));
      return cached.title ?? null;
    } catch {
      // Cache corrupt — refetch
    }
  }

  if (!checkLinearAvailable()) return null;

  try {
    const out = execFileSync(
      "linear",
      ["issue", "view", issueIdentifier, "--json", "--no-pager"],
      { stdio: ["pipe", "pipe", "pipe"], timeout: 15000, encoding: "utf-8" },
    );
    const data = JSON.parse(out);
    writeFileSync(cacheFile, `${JSON.stringify(data, null, 2)}\n`);
    return data.title ?? null;
  } catch (err) {
    warn(`Failed to fetch Linear title for ${issueIdentifier}: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Extract subcommand
// ---------------------------------------------------------------------------

function discoverProducts() {
  if (!existsSync(SYMPHONY_LOG_DIR)) return [];
  const entries = readdirSync(SYMPHONY_LOG_DIR, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => ({
      product: e.name,
      logPath: join(SYMPHONY_LOG_DIR, e.name, "symphony.jsonl"),
    }))
    .filter(({ logPath }) => existsSync(logPath));
}

/**
 * Parse a stage_completed event into a token-history record.
 */
function mapEvent(event, product) {
  return {
    timestamp: event.timestamp ?? new Date().toISOString(),
    product,
    issue_id: event.issue_id ?? null,
    issue_identifier: event.issue_identifier ?? null,
    issue_title: null, // Enriched later
    session_id: event.session_id ?? null,
    stage_name: event.stage_name ?? null,
    outcome: event.outcome ?? null,
    total_input_tokens: event.total_input_tokens ?? 0,
    total_output_tokens: event.total_output_tokens ?? 0,
    total_total_tokens: event.total_total_tokens ?? 0,
    no_cache_tokens: event.no_cache_tokens ?? 0,
    total_cache_read_tokens: event.total_cache_read_tokens ?? 0,
    total_cache_write_tokens: event.total_cache_write_tokens ?? 0,
    input_tokens: event.input_tokens ?? 0,
    output_tokens: event.output_tokens ?? 0,
    total_tokens: event.total_tokens ?? 0,
    cache_read_tokens: event.cache_read_tokens ?? 0,
    cache_write_tokens: event.cache_write_tokens ?? 0,
    reasoning_tokens: event.reasoning_tokens ?? 0,
    turns_used: event.turns_used ?? event.turn_count ?? 0,
    duration_ms: event.duration_ms ?? 0,
    extracted_at: new Date().toISOString(),
  };
}

function runExtract() {
  const products = discoverProducts();
  if (products.length === 0) {
    info("No product log directories found");
  }

  let totalExtracted = 0;
  let totalSkipped = 0;
  const seenIdentifiers = new Set();

  for (const { product, logPath } of products) {
    const fileSize = getFileSize(logPath);
    if (fileSize === 0) {
      info(`Skipping empty log file: ${logPath}`);
      continue;
    }

    const { lines, newOffset, newInode } = readNewLines(logPath);

    if (lines.length === 0) {
      writeHwm(logPath, { inode: newInode, offset: newOffset });
      continue;
    }

    const records = [];
    for (const line of lines) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        warn(`Malformed JSONL line in ${logPath}: ${line.slice(0, 100)}`);
        totalSkipped++;
        continue;
      }

      if (event.event !== "stage_completed") continue;
      // Accept both completed and failed outcomes
      if (event.outcome !== "completed" && event.outcome !== "failed") continue;

      const record = mapEvent(event, product);
      if (record.issue_identifier) {
        seenIdentifiers.add(record.issue_identifier);
      }
      records.push(record);
    }

    // Enrich with Linear titles (one CLI call per unique identifier)
    const titleCache = new Map();
    for (const id of seenIdentifiers) {
      if (!titleCache.has(id)) {
        titleCache.set(id, getLinearTitle(id));
      }
    }
    for (const record of records) {
      if (record.issue_identifier && titleCache.has(record.issue_identifier)) {
        record.issue_title = titleCache.get(record.issue_identifier);
      }
    }

    // Append to token-history.jsonl
    if (records.length > 0) {
      const jsonlData = `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
      appendFileSync(TOKEN_HISTORY_PATH, jsonlData);
      totalExtracted += records.length;
    }

    // Update HWM
    writeHwm(logPath, { inode: newInode, offset: newOffset });
  }

  // Snapshot config hashes
  snapshotConfigHashes();

  info(
    `Extraction complete: ${totalExtracted} records extracted, ${totalSkipped} lines skipped`,
  );
}

// ---------------------------------------------------------------------------
// Config hash snapshot
// ---------------------------------------------------------------------------

function snapshotConfigHashes() {
  const scriptDir = resolve(new URL(".", import.meta.url).pathname);
  const symphonyRoot = resolve(scriptDir, "..");

  const configFiles = [];
  // Gather known config-ish files
  const candidates = [
    "pipeline-config",
    "biome.json",
    "tsconfig.json",
    "tsconfig.build.json",
    "vitest.config.ts",
    "package.json",
  ];

  for (const candidate of candidates) {
    const fullPath = join(symphonyRoot, candidate);
    if (!existsSync(fullPath)) continue;
    const stat = statSync(fullPath);
    if (stat.isDirectory()) {
      gatherFiles(fullPath, configFiles);
    } else {
      configFiles.push(fullPath);
    }
  }

  // Also gather SKILL.md files from pipeline-config and any subdirectories
  const skillFiles = [];
  gatherFilesByPattern(symphonyRoot, "SKILL.md", skillFiles);

  const hashes = {};
  for (const file of [...configFiles, ...skillFiles]) {
    try {
      const relPath = file.replace(`${symphonyRoot}/`, "");
      const content = readFileSync(file);
      hashes[relPath] = createHash("sha256")
        .update(content)
        .digest("hex")
        .slice(0, 16);
    } catch {
      // Skip unreadable files
    }
  }

  const snapshot = {
    timestamp: new Date().toISOString(),
    config_hashes: hashes,
    file_count: Object.keys(hashes).length,
  };

  appendFileSync(CONFIG_HISTORY_PATH, `${JSON.stringify(snapshot)}\n`);
}

function gatherFiles(dir, out) {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name === "node_modules" ||
          entry.name === ".git" ||
          entry.name === "dist"
        )
          continue;
        gatherFiles(fullPath, out);
      } else {
        out.push(fullPath);
      }
    }
  } catch {
    // Skip unreadable directories
  }
}

function gatherFilesByPattern(dir, pattern, out) {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name === "node_modules" ||
          entry.name === ".git" ||
          entry.name === "dist"
        )
          continue;
        gatherFilesByPattern(fullPath, pattern, out);
      } else if (entry.name === pattern) {
        out.push(fullPath);
      }
    }
  } catch {
    // Skip unreadable directories
  }
}

// ---------------------------------------------------------------------------
// Analyze subcommand — SYMPH-130
// ---------------------------------------------------------------------------

/**
 * Read all records from a JSONL file. Returns [] if file missing/empty.
 */
function readJsonl(filePath) {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, "utf-8").trim();
  if (!content) return [];
  return content
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

/**
 * Compute median of a numeric array. Returns 0 for empty arrays.
 */
function median(arr) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
}

/**
 * Compute mean of a numeric array. Returns 0 for empty arrays.
 */
function mean(arr) {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

/**
 * Compute standard deviation.
 */
function stddev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const variance = arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

/**
 * Round to specified decimal places.
 */
function round(val, decimals = 1) {
  const factor = 10 ** decimals;
  return Math.round(val * factor) / factor;
}

/**
 * Parse timestamp to Date object.
 */
function parseTs(ts) {
  return new Date(ts);
}

/**
 * Get days ago boundary from a reference date.
 */
function daysAgo(days, refDate = new Date()) {
  const d = new Date(refDate);
  d.setDate(d.getDate() - days);
  d.setHours(0, 0, 0, 0);
  return d;
}

/**
 * Get the date string (YYYY-MM-DD) from a Date.
 */
function dateKey(d) {
  return d.toISOString().slice(0, 10);
}

/**
 * Filter records to a date window (>= start, < end).
 */
function filterByDateRange(records, startDate, endDate) {
  const start = startDate.getTime();
  const end = endDate.getTime();
  return records.filter((r) => {
    const t = parseTs(r.timestamp).getTime();
    return t >= start && t < end;
  });
}

/**
 * Compute data span in days.
 */
function dataSpanDays(records) {
  if (records.length === 0) return 0;
  const timestamps = records.map((r) => parseTs(r.timestamp).getTime());
  const minT = Math.min(...timestamps);
  const maxT = Math.max(...timestamps);
  return Math.ceil((maxT - minT) / (1000 * 60 * 60 * 24));
}

/**
 * Determine cold-start tier: "<7d", "7-29d", ">=30d".
 */
function coldStartTier(spanDays) {
  if (spanDays < 7) return "<7d";
  if (spanDays < 30) return "7-29d";
  return ">=30d";
}

/**
 * Compute efficiency scorecard metrics for a set of records.
 * Failed stages are excluded from efficiency metrics but included in spend.
 */
function computeEfficiencyScorecard(records) {
  const completed = records.filter((r) => r.outcome === "completed");

  let totalInput = 0;
  let totalOutput = 0;
  let totalTotal = 0;
  let totalCacheRead = 0;
  let totalNoCache = 0;
  let totalTurns = 0;

  for (const r of completed) {
    totalInput += r.total_input_tokens ?? 0;
    totalOutput += r.total_output_tokens ?? 0;
    totalTotal += r.total_total_tokens ?? 0;
    totalCacheRead += r.total_cache_read_tokens ?? 0;
    totalNoCache += r.no_cache_tokens ?? 0;
    totalTurns += r.turns_used ?? 0;
  }

  // Cache efficiency: cache_read / (input + cache_read) * 100
  const inputPlusCacheRead = totalInput + totalCacheRead;
  const cacheEfficiency =
    inputPlusCacheRead > 0 ? (totalCacheRead / inputPlusCacheRead) * 100 : 0;

  // Output ratio: output / total * 100
  const outputRatio = totalTotal > 0 ? (totalOutput / totalTotal) * 100 : 0;

  // Wasted context: no_cache / input * 100
  const wastedContext = totalInput > 0 ? (totalNoCache / totalInput) * 100 : 0;

  // Tokens per turn
  const tokensPerTurn = totalTurns > 0 ? totalTotal / totalTurns : 0;

  // First-pass rate: 1 - (issues with >1 implement completed) / (total unique issues)
  const issueImplementCounts = {};
  for (const r of records) {
    if (
      r.stage_name === "implement" &&
      r.outcome === "completed" &&
      r.issue_identifier
    ) {
      issueImplementCounts[r.issue_identifier] =
        (issueImplementCounts[r.issue_identifier] ?? 0) + 1;
    }
  }
  const totalUniqueIssues = Object.keys(issueImplementCounts).length;
  const reworkIssues = Object.values(issueImplementCounts).filter(
    (c) => c > 1,
  ).length;
  const firstPassRate =
    totalUniqueIssues > 0 ? (1 - reworkIssues / totalUniqueIssues) * 100 : 100;

  // Failure rate per stage type
  const stageTotal = {};
  const stageFailed = {};
  for (const r of records) {
    if (!r.stage_name) continue;
    stageTotal[r.stage_name] = (stageTotal[r.stage_name] ?? 0) + 1;
    if (r.outcome === "failed") {
      stageFailed[r.stage_name] = (stageFailed[r.stage_name] ?? 0) + 1;
    }
  }
  const failureRate = {};
  for (const stage of Object.keys(stageTotal)) {
    failureRate[stage] = round(
      ((stageFailed[stage] ?? 0) / stageTotal[stage]) * 100,
      1,
    );
  }

  return {
    cache_efficiency: round(cacheEfficiency, 1),
    output_ratio: round(outputRatio, 1),
    wasted_context: round(wastedContext, 1),
    tokens_per_turn: round(tokensPerTurn, 0),
    first_pass_rate: round(firstPassRate, 1),
    failure_rate: failureRate,
  };
}

/**
 * Compute efficiency scorecard with trends (current, 7d, 30d).
 */
function computeScorecardWithTrends(records, now) {
  const d7 = daysAgo(7, now);
  const d30 = daysAgo(30, now);

  const currentScorecard = computeEfficiencyScorecard(records);
  const last7Records = filterByDateRange(records, d7, now);
  const last30Records = filterByDateRange(records, d30, now);
  const scorecard7 = computeEfficiencyScorecard(last7Records);
  const scorecard30 = computeEfficiencyScorecard(last30Records);

  const result = {};
  for (const key of [
    "cache_efficiency",
    "output_ratio",
    "wasted_context",
    "tokens_per_turn",
    "first_pass_rate",
  ]) {
    result[key] = {
      current: currentScorecard[key],
      trend_7d: scorecard7[key],
      trend_30d: scorecard30[key],
    };
  }

  // failure_rate has nested structure (per stage)
  result.failure_rate = {
    current: currentScorecard.failure_rate,
    trend_7d: scorecard7.failure_rate,
    trend_30d: scorecard30.failure_rate,
  };

  return result;
}

/**
 * Compute WoW delta. Returns null if insufficient data.
 * wow_delta_pct = (current_week - prior_week) / prior_week * 100
 */
function computeWowDelta(records, metricFn, now) {
  const d7 = daysAgo(7, now);
  const d14 = daysAgo(14, now);

  const currentWeekRecords = filterByDateRange(records, d7, now);
  const priorWeekRecords = filterByDateRange(records, d14, d7);

  if (currentWeekRecords.length === 0 || priorWeekRecords.length === 0) {
    return null;
  }

  const currentVal = metricFn(currentWeekRecords);
  const priorVal = metricFn(priorWeekRecords);

  if (priorVal === 0) return null;
  return round(((currentVal - priorVal) / priorVal) * 100, 1);
}

/**
 * Build executive summary with WoW deltas.
 */
function buildExecutiveSummary(records, spanDays, now) {
  const hasWow = spanDays >= 14;

  const totalTokens = records.reduce(
    (s, r) => s + (r.total_total_tokens ?? 0),
    0,
  );
  const totalStages = records.length;

  const summary = {
    total_tokens: { value: totalTokens },
    total_stages: { value: totalStages },
    unique_issues: {
      value: new Set(records.map((r) => r.issue_identifier).filter(Boolean))
        .size,
    },
    data_span_days: spanDays,
  };

  if (hasWow) {
    const tokenFn = (recs) =>
      recs.reduce((s, r) => s + (r.total_total_tokens ?? 0), 0);
    const stageFn = (recs) => recs.length;

    summary.total_tokens.wow_delta_pct = computeWowDelta(records, tokenFn, now);
    summary.total_stages.wow_delta_pct = computeWowDelta(records, stageFn, now);
  }

  return summary;
}

/**
 * Detect config-change markers from config-history.jsonl.
 */
function computeConfigChangeMarkers(configRecords) {
  if (configRecords.length < 2) return [];
  const markers = [];
  for (let i = 1; i < configRecords.length; i++) {
    const prev = configRecords[i - 1];
    const curr = configRecords[i];
    const prevHashes = prev.config_hashes ?? {};
    const currHashes = curr.config_hashes ?? {};

    const changedFiles = [];
    const allKeys = new Set([
      ...Object.keys(prevHashes),
      ...Object.keys(currHashes),
    ]);
    for (const key of allKeys) {
      if (prevHashes[key] !== currHashes[key]) {
        changedFiles.push(key);
      }
    }
    if (changedFiles.length > 0) {
      markers.push({
        date: dateKey(parseTs(curr.timestamp)),
        timestamp: curr.timestamp,
        changed_files: changedFiles,
      });
    }
  }
  return markers;
}

/**
 * Compute per-stage utilization trend: daily avg tokens per stage.
 */
function computePerStageTrend(records, configRecords) {
  const stageNames = [
    ...new Set(records.map((r) => r.stage_name).filter(Boolean)),
  ];
  const trend = {};

  for (const stage of stageNames) {
    const stageRecords = records.filter((r) => r.stage_name === stage);
    // Group by date
    const byDate = {};
    for (const r of stageRecords) {
      const dk = dateKey(parseTs(r.timestamp));
      if (!byDate[dk]) byDate[dk] = [];
      byDate[dk].push(r.total_total_tokens ?? 0);
    }
    const dailyAvg = {};
    for (const [date, vals] of Object.entries(byDate)) {
      dailyAvg[date] = round(mean(vals), 0);
    }
    trend[stage] = { daily_avg: dailyAvg };
  }

  // Add config-change markers at dates where config hashes changed
  const configMarkers = computeConfigChangeMarkers(configRecords);
  if (configMarkers.length > 0) {
    for (const stage of stageNames) {
      trend[stage].config_changes = configMarkers;
    }
  }

  return trend;
}

/**
 * Compute per-ticket cost trend: rolling median and mean of total tokens per ticket.
 */
function computePerTicketTrend(records) {
  const issueTokens = {};
  for (const r of records) {
    const id = r.issue_identifier;
    if (!id) continue;
    issueTokens[id] = (issueTokens[id] ?? 0) + (r.total_total_tokens ?? 0);
  }
  const values = Object.values(issueTokens);
  return {
    median: round(median(values), 0),
    mean: round(mean(values), 0),
    ticket_count: values.length,
  };
}

/**
 * Compute per-product breakdown.
 */
function computePerProduct(records) {
  const byProduct = {};
  for (const r of records) {
    const p = r.product ?? "unknown";
    if (!byProduct[p]) {
      byProduct[p] = {
        total_tokens: 0,
        total_stages: 0,
        unique_issues: new Set(),
      };
    }
    byProduct[p].total_tokens += r.total_total_tokens ?? 0;
    byProduct[p].total_stages += 1;
    if (r.issue_identifier) byProduct[p].unique_issues.add(r.issue_identifier);
  }
  const result = {};
  for (const [product, data] of Object.entries(byProduct)) {
    result[product] = {
      total_tokens: data.total_tokens,
      total_stages: data.total_stages,
      unique_issues: data.unique_issues.size,
    };
  }
  return result;
}

/**
 * Detect inflections: points where 7d avg crosses 30d avg by >15%.
 * Requires >=20 samples in baseline (30d).
 */
function detectInflections(records, configRecords, now) {
  const stageNames = [
    ...new Set(records.map((r) => r.stage_name).filter(Boolean)),
  ];
  const inflections = [];

  for (const stage of stageNames) {
    const stageRecords = records.filter((r) => r.stage_name === stage);

    const d7 = daysAgo(7, now);
    const d30 = daysAgo(30, now);
    const last30 = filterByDateRange(stageRecords, d30, now);
    const last7 = filterByDateRange(stageRecords, d7, now);

    // Need >=20 samples in 30d baseline
    if (last30.length < 20) continue;

    const avg30 = mean(last30.map((r) => r.total_total_tokens ?? 0));
    const avg7 = mean(last7.map((r) => r.total_total_tokens ?? 0));

    if (avg30 === 0) continue;
    const pctChange = ((avg7 - avg30) / avg30) * 100;

    if (Math.abs(pctChange) <= 15) continue;

    const direction = pctChange > 0 ? "increase" : "decrease";
    const attributions = [];

    // Ticket-mix attribution: analyze complexity distribution in +-48h window
    const windowStart = new Date(d7.getTime() - 48 * 60 * 60 * 1000);
    const windowEnd = new Date(d7.getTime() + 48 * 60 * 60 * 1000);
    const windowRecords = filterByDateRange(
      stageRecords,
      windowStart,
      windowEnd,
    );
    const baselineRecords = filterByDateRange(stageRecords, d30, d7);

    if (windowRecords.length > 0 && baselineRecords.length > 0) {
      const windowAvgTokens = mean(
        windowRecords.map((r) => r.total_total_tokens ?? 0),
      );
      const baselineAvgTokens = mean(
        baselineRecords.map((r) => r.total_total_tokens ?? 0),
      );
      const windowIssues = [
        ...new Set(
          windowRecords.map((r) => r.issue_identifier).filter(Boolean),
        ),
      ];

      attributions.push({
        type: "ticket_mix",
        description: `coincides with ${windowIssues.length} tickets in window averaging ${round(windowAvgTokens, 0)} tokens vs baseline ${round(baselineAvgTokens, 0)}`,
        window_issues: windowIssues,
        window_avg_tokens: round(windowAvgTokens, 0),
        baseline_avg_tokens: round(baselineAvgTokens, 0),
      });
    }

    // Config-change correlation: check for hash changes within 2 days prior
    const configChanges = computeConfigChangeMarkers(configRecords);
    for (const change of configChanges) {
      const changeDate = parseTs(change.timestamp);
      const changeDaysAgo =
        (d7.getTime() - changeDate.getTime()) / (1000 * 60 * 60 * 24);
      if (changeDaysAgo >= 0 && changeDaysAgo <= 2) {
        attributions.push({
          type: "config_change",
          description: `coincides with config change on ${change.date}: ${change.changed_files.join(", ")}`,
          date: change.date,
          changed_files: change.changed_files,
        });
      }
    }

    inflections.push({
      stage,
      direction,
      pct_change: round(pctChange, 1),
      avg_7d: round(avg7, 0),
      avg_30d: round(avg30, 0),
      attributions,
    });
  }

  return inflections;
}

/**
 * Get Linear parent spec for an issue using the Linear CLI.
 * Caches results in linear-cache/{identifier}-parent.json.
 */
function getLinearParentSpec(issueId, issueIdentifier) {
  if (!issueId && !issueIdentifier) return null;

  const cacheKey = issueIdentifier ?? issueId;
  const cacheFile = join(LINEAR_CACHE_DIR, `${cacheKey}-parent.json`);
  if (existsSync(cacheFile)) {
    try {
      return JSON.parse(readFileSync(cacheFile, "utf-8"));
    } catch {
      // Cache corrupt — refetch
    }
  }

  if (!checkLinearAvailable()) return null;

  try {
    const query = `{ issue(id: "${issueId}") { parent { identifier title description } } }`;
    const out = execFileSync("linear", ["api", query, "--silent"], {
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 15000,
      encoding: "utf-8",
    });
    const data = JSON.parse(out);
    const parent = data?.data?.issue?.parent ?? null;
    writeFileSync(cacheFile, `${JSON.stringify(parent, null, 2)}\n`);
    return parent;
  } catch (err) {
    warn(`Failed to fetch Linear parent for ${cacheKey}: ${err.message}`);
    return null;
  }
}

/**
 * Classify a parent spec's complexity based on description content.
 */
function classifyParentComplexity(parent) {
  if (!parent || !parent.description)
    return { classification: "UNKNOWN", task_count: 0 };
  const desc = parent.description;
  const taskLines = desc
    .split("\n")
    .filter(
      (l) =>
        /^\s*[-*]\s*\[/.test(l) ||
        /^\s*\d+[.)]\s/.test(l) ||
        /^\s*[-*]\s+\S/.test(l),
    );
  const taskCount = taskLines.length;
  let classification = "SIMPLE";
  if (taskCount >= 8) classification = "COMPLEX";
  else if (taskCount >= 4) classification = "MODERATE";
  return { classification, task_count: taskCount };
}

/**
 * Detect outliers (>2σ) and generate hypotheses with Linear parent spec.
 */
function detectOutliers(records) {
  const issueTokens = {};
  const issueMeta = {};
  for (const r of records) {
    const id = r.issue_identifier;
    if (!id) continue;
    issueTokens[id] = (issueTokens[id] ?? 0) + (r.total_total_tokens ?? 0);
    if (!issueMeta[id]) {
      issueMeta[id] = {
        issue_id: r.issue_id,
        issue_identifier: id,
        issue_title: r.issue_title,
      };
    }
  }

  const values = Object.values(issueTokens);
  if (values.length < 3) return [];

  const m = mean(values);
  const sd = stddev(values);
  if (sd === 0) return [];

  const threshold = m + 2 * sd;
  const outliers = [];

  for (const [identifier, tokens] of Object.entries(issueTokens)) {
    if (tokens > threshold) {
      const meta = issueMeta[identifier];
      const zScore = round((tokens - m) / sd, 1);

      // Try to get parent spec from Linear for hypothesis
      const parent = getLinearParentSpec(meta.issue_id, meta.issue_identifier);
      const complexity = classifyParentComplexity(parent);

      const hypothesis = parent
        ? `Parent spec "${parent.title}" (${parent.identifier}) classified ${complexity.classification} with ${complexity.task_count} tasks — high token usage may reflect spec complexity`
        : "Linear parent spec unavailable — unable to determine complexity attribution";

      outliers.push({
        issue_identifier: identifier,
        issue_title: meta.issue_title,
        total_tokens: tokens,
        z_score: zScore,
        multiplier: round(tokens / m, 1),
        linear_url: `https://linear.app/mobilyze-llc/issue/${identifier}`,
        threshold: round(threshold, 0),
        mean: round(m, 0),
        stddev: round(sd, 0),
        parent: parent
          ? {
              identifier: parent.identifier,
              title: parent.title,
              complexity: complexity.classification,
              task_count: complexity.task_count,
            }
          : null,
        hypothesis,
      });
    }
  }

  outliers.sort((a, b) => b.total_tokens - a.total_tokens);
  return outliers;
}

/**
 * Build issue leaderboard sorted by total token spend (top 25).
 * Ported from renderHtml() so computeAnalysis() can include it in the JSON output.
 * SYMPH-179
 */
function buildLeaderboard(records) {
  const issueTokens = {};
  for (const r of records) {
    const id = r.issue_identifier;
    if (!id) continue;
    issueTokens[id] = (issueTokens[id] ?? 0) + (r.total_total_tokens ?? 0);
  }
  return Object.entries(issueTokens)
    .map(([id, tokens]) => {
      const rec = records.find((r) => r.issue_identifier === id);
      return {
        identifier: id,
        title: rec?.issue_title ?? "",
        tokens,
        linear_url: `https://linear.app/mobilyze-llc/issue/${id}`,
      };
    })
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, 25);
}

/**
 * Build a daily metric series over the last 30 days.
 * Port of the closure inside renderHtml() — made top-level so computeAnalysis() can reuse it.
 * @param {Array} records - JSONL records to aggregate
 * @param {function} metricFn - (dayRecords: Array) => number
 * @returns {number[]} sparse array (only days with data)
 */
function buildDailyMetricSeries(records, metricFn) {
  const now = new Date();
  const vals = [];
  for (let i = 29; i >= 0; i--) {
    const dayStart = daysAgo(i + 1, now);
    const dayEnd = daysAgo(i, now);
    const dayRecords = filterByDateRange(records, dayStart, dayEnd);
    if (dayRecords.length > 0) {
      vals.push(metricFn(dayRecords));
    }
  }
  return vals;
}

/**
 * Compute per-stage average turns and cache rate (includes ALL stages).
 * Returns { [stage]: { avg_turns, cache_rate, count } }.
 *   avg_turns  — mean turns_used across all records for that stage (rounded to 1 decimal)
 *   cache_rate — cache_read / (input + cache_read) * 100 for that stage (rounded to 1 decimal)
 *   count      — number of records for that stage
 */
function computePerStageStats(records) {
  const byStage = {};
  for (const r of records) {
    const s = r.stage_name ?? "unknown";
    if (!byStage[s]) {
      byStage[s] = {
        total_turns: 0,
        total_input: 0,
        total_cache_read: 0,
        count: 0,
      };
    }
    byStage[s].total_turns += r.turns_used ?? 0;
    byStage[s].total_input += r.total_input_tokens ?? 0;
    byStage[s].total_cache_read += r.total_cache_read_tokens ?? 0;
    byStage[s].count += 1;
  }
  const result = {};
  for (const [stage, data] of Object.entries(byStage)) {
    const avgTurns = data.count > 0 ? data.total_turns / data.count : 0;
    const inputPlusCacheRead = data.total_input + data.total_cache_read;
    const cacheRate =
      inputPlusCacheRead > 0
        ? (data.total_cache_read / inputPlusCacheRead) * 100
        : 0;
    result[stage] = {
      avg_turns: round(avgTurns, 1),
      cache_rate: round(cacheRate, 1),
      count: data.count,
    };
  }
  return result;
}

/**
 * Compute per-stage token spend (includes ALL stages, both completed and failed).
 */
function computePerStageSpend(records) {
  const byStage = {};
  for (const r of records) {
    const s = r.stage_name ?? "unknown";
    if (!byStage[s]) {
      byStage[s] = { total_tokens: 0, count: 0, completed: 0, failed: 0 };
    }
    byStage[s].total_tokens += r.total_total_tokens ?? 0;
    byStage[s].count += 1;
    if (r.outcome === "completed") byStage[s].completed += 1;
    if (r.outcome === "failed") byStage[s].failed += 1;
  }
  return byStage;
}

/**
 * Compute analysis result object from token/config history.
 * Returns the result object (does not write to stdout).
 */
/**
 * Generate LLM insight for an inflection using `claude -p` CLI.
 * Gated behind TOKEN_REPORT_LLM=1 env var — returns null otherwise.
 * Graceful degradation: returns null if CLI unavailable or fails.
 */
function generateInflectionInsight(inflection) {
  if (process.env.TOKEN_REPORT_LLM !== "1") return null;
  try {
    const prompt = [
      "You are a DevOps analyst. Analyze this token usage inflection and provide a 1-2 sentence insight.",
      `Stage: ${inflection.metric}`,
      `Direction: ${inflection.direction}`,
      `Magnitude: ${(inflection.magnitude * 100).toFixed(1)}%`,
      `7-day avg: ${inflection.avg_7d} tokens`,
      `30-day avg: ${inflection.avg_30d} tokens`,
      inflection.context ? `Context: ${inflection.context}` : "",
      "Respond with only the insight, no preamble.",
    ]
      .filter(Boolean)
      .join("\n");
    const result = execFileSync("claude", ["-p", prompt], {
      encoding: "utf-8",
      timeout: 30_000,
    });
    return result.trim() || null;
  } catch {
    return null;
  }
}

function computeAnalysis() {
  const records = readJsonl(TOKEN_HISTORY_PATH);
  const configRecords = readJsonl(CONFIG_HISTORY_PATH);

  if (records.length === 0) {
    return {
      cold_start: true,
      cold_start_tier: "<7d",
      message: "No token history data available",
      efficiency_scorecard: {
        cache_efficiency: { current: 0, trend_7d: 0, trend_30d: 0 },
        output_ratio: { current: 0, trend_7d: 0, trend_30d: 0 },
        wasted_context: { current: 0, trend_7d: 0, trend_30d: 0 },
        tokens_per_turn: { current: 0, trend_7d: 0, trend_30d: 0 },
        first_pass_rate: { current: 100, trend_7d: 100, trend_30d: 100 },
        failure_rate: { current: {}, trend_7d: {}, trend_30d: {} },
      },
      executive_summary: {
        total_tokens: { value: 0 },
        total_stages: { value: 0 },
        unique_issues: { value: 0 },
        data_span_days: 0,
      },
      per_stage_spend: {},
      per_stage_stats: {},
      per_stage_trend: {},
      per_ticket_trend: { median: 0, mean: 0, ticket_count: 0 },
      per_product: {},
      daily_series: {
        cacheEff: [],
        outputRatio: [],
        wastedCtx: [],
        tokPerTurn: [],
        firstPass: [],
        failureRate: [],
      },
      inflections: [],
      outliers: [],
      leaderboard: [],
    };
  }

  // Filter spec-gen stage from all aggregations (SYMPH-185)
  const filteredRecords = records.filter((r) => r.stage_name !== "spec-gen");

  const spanDays = dataSpanDays(filteredRecords);
  const tier = coldStartTier(spanDays);
  const now = new Date();

  const isColdStart = spanDays < 7;

  const scorecard = computeScorecardWithTrends(filteredRecords, now);
  const executiveSummary = buildExecutiveSummary(
    filteredRecords,
    spanDays,
    now,
  );
  const perStageSpend = computePerStageSpend(filteredRecords);
  const perStageStats = computePerStageStats(filteredRecords);
  const perStageTrend = computePerStageTrend(filteredRecords, configRecords);
  const perTicketTrend = computePerTicketTrend(filteredRecords);
  const perProduct = computePerProduct(filteredRecords);
  const leaderboard = buildLeaderboard(filteredRecords);

  // Inflection detection and outliers: only meaningful with sufficient data
  let inflections = [];
  let outliers = [];

  if (tier === ">=30d") {
    const d7 = daysAgo(7, now);
    const rawInflections = detectInflections(
      filteredRecords,
      configRecords,
      now,
    );
    // Transform detectInflections output to UI Inflection shape (SYMPH-185)
    inflections = rawInflections.map((inf) => {
      const mapped = {
        date: dateKey(d7),
        metric: inf.stage,
        direction: inf.direction === "increase" ? "up" : "down",
        magnitude: round(Math.abs(inf.pct_change) / 100, 2),
        context: inf.attributions.map((a) => a.description).join("; ") || null,
        avg_7d: inf.avg_7d,
        avg_30d: inf.avg_30d,
        attributions: inf.attributions,
        llm_insight: null,
      };
      mapped.llm_insight = generateInflectionInsight(mapped);
      return mapped;
    });
    outliers = detectOutliers(filteredRecords);
  } else if (tier === "7-29d") {
    outliers = detectOutliers(filteredRecords);
    inflections = [];
  }

  // Build daily metric series for efficiency scorecard sparklines
  const dailySeries = {
    cacheEff: buildDailyMetricSeries(filteredRecords, (recs) => {
      const sc = computeEfficiencyScorecard(recs);
      return sc.cache_efficiency;
    }),
    outputRatio: buildDailyMetricSeries(filteredRecords, (recs) => {
      const sc = computeEfficiencyScorecard(recs);
      return sc.output_ratio;
    }),
    wastedCtx: buildDailyMetricSeries(filteredRecords, (recs) => {
      const sc = computeEfficiencyScorecard(recs);
      return sc.wasted_context;
    }),
    tokPerTurn: buildDailyMetricSeries(filteredRecords, (recs) => {
      const sc = computeEfficiencyScorecard(recs);
      return sc.tokens_per_turn;
    }),
    firstPass: buildDailyMetricSeries(filteredRecords, (recs) => {
      const sc = computeEfficiencyScorecard(recs);
      return sc.first_pass_rate;
    }),
    failureRate: buildDailyMetricSeries(filteredRecords, (recs) => {
      const total = recs.length;
      const failed = recs.filter((r) => r.outcome === "failed").length;
      return total > 0 ? (failed / total) * 100 : 0;
    }),
  };

  return {
    ...(isColdStart && { cold_start: true }),
    cold_start_tier: tier,
    ...(isColdStart && {
      message:
        "insufficient data — rolling averages, inflection detection, and attribution require >=7 days",
    }),
    analyzed_at: now.toISOString(),
    data_span_days: spanDays,
    record_count: records.length,
    efficiency_scorecard: scorecard,
    executive_summary: executiveSummary,
    per_stage_spend: perStageSpend,
    per_stage_stats: perStageStats,
    per_stage_trend: perStageTrend,
    per_ticket_trend: perTicketTrend,
    per_product: perProduct,
    daily_series: dailySeries,
    inflections:
      tier === "<7d" ? { status: "insufficient data", items: [] } : inflections,
    outliers:
      tier === "<7d" ? { status: "insufficient data", items: [] } : outliers,
    leaderboard,
  };
}

/**
 * Main analyze function — writes analysis.json to DATA_DIR and prints to stdout.
 */
function runAnalyze() {
  const result = computeAnalysis();
  const json = JSON.stringify(result, null, 2);
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(join(DATA_DIR, "analysis.json"), `${json}\n`);
  info(`Analysis written to ${join(DATA_DIR, "analysis.json")}`);
  process.stdout.write(`${json}\n`);
}

// ---------------------------------------------------------------------------
// Render subcommand — SYMPH-131
// ---------------------------------------------------------------------------

const REPORTS_DIR = join(SYMPHONY_HOME, "reports");

/**
 * Format a number with thousands separators.
 */
function fmtNum(n) {
  if (n == null || Number.isNaN(n)) return "0";
  return Math.round(n).toLocaleString("en-US");
}

/**
 * Escape HTML special characters.
 */
function escHtml(s) {
  if (!s) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Generate an inline SVG sparkline from an array of {x, y} points.
 * x values are normalized to [0, width], y values to [0, height].
 */
function sparklineSvg(values, opts = {}) {
  const {
    width = 120,
    height = 30,
    stroke = "#58a6ff",
    strokeWidth = 1.5,
  } = opts;
  if (!values || values.length < 2) {
    return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"></svg>`;
  }
  const minY = Math.min(...values);
  const maxY = Math.max(...values);
  const rangeY = maxY - minY || 1;
  const points = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * width;
      const y = height - ((v - minY) / rangeY) * (height - 4) - 2;
      return `${round(x, 1)},${round(y, 1)}`;
    })
    .join(" ");
  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><polyline points="${points}" fill="none" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
}

/**
 * Build a multi-line SVG chart for per-stage trends.
 */
function multiLineSvg(stageData, configChanges, opts = {}) {
  const { width = 600, height = 200 } = opts;
  const colors = [
    "#58a6ff",
    "#3fb950",
    "#d29922",
    "#f85149",
    "#bc8cff",
    "#79c0ff",
    "#56d364",
    "#e3b341",
  ];
  const allDates = new Set();
  for (const stage of Object.keys(stageData)) {
    for (const d of Object.keys(stageData[stage].daily_avg ?? {})) {
      allDates.add(d);
    }
  }
  const sortedDates = [...allDates].sort();
  if (sortedDates.length < 2) {
    return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><text x="10" y="20" fill="#8b949e" font-size="12">Insufficient data for trend chart</text></svg>`;
  }

  const stages = Object.keys(stageData);
  const allVals = [];
  for (const stage of stages) {
    const avg = stageData[stage].daily_avg ?? {};
    for (const d of sortedDates) {
      if (avg[d] != null) allVals.push(avg[d]);
    }
  }
  const minY = Math.min(...allVals, 0);
  const maxY = Math.max(...allVals, 1);
  const rangeY = maxY - minY || 1;
  const padL = 50;
  const padR = 10;
  const padT = 10;
  const padB = 25;
  const chartW = width - padL - padR;
  const chartH = height - padT - padB;

  let svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg" style="background:#0d1117;border-radius:6px">`;

  // Grid lines
  for (let i = 0; i <= 4; i++) {
    const y = padT + (chartH / 4) * i;
    const val = maxY - (rangeY / 4) * i;
    svg += `<line x1="${padL}" y1="${y}" x2="${width - padR}" y2="${y}" stroke="#21262d" stroke-width="1"/>`;
    svg += `<text x="${padL - 5}" y="${y + 4}" fill="#8b949e" font-size="10" text-anchor="end">${fmtNum(val)}</text>`;
  }

  // Config change markers
  if (configChanges) {
    for (const cc of configChanges) {
      const idx = sortedDates.indexOf(cc.date);
      if (idx >= 0) {
        const x = padL + (idx / (sortedDates.length - 1)) * chartW;
        svg += `<line x1="${x}" y1="${padT}" x2="${x}" y2="${padT + chartH}" stroke="#d29922" stroke-width="1" stroke-dasharray="4,4"/>`;
        svg += `<text x="${x}" y="${padT - 2}" fill="#d29922" font-size="9" text-anchor="middle">⚙</text>`;
      }
    }
  }

  // Stage lines
  stages.forEach((stage, si) => {
    const avg = stageData[stage].daily_avg ?? {};
    const pts = [];
    for (const d of sortedDates) {
      if (avg[d] != null) {
        const x =
          padL + (sortedDates.indexOf(d) / (sortedDates.length - 1)) * chartW;
        const y = padT + chartH - ((avg[d] - minY) / rangeY) * chartH;
        pts.push(`${round(x, 1)},${round(y, 1)}`);
      }
    }
    if (pts.length > 1) {
      const color = colors[si % colors.length];
      svg += `<polyline points="${pts.join(" ")}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>`;
    }
  });

  // Legend
  stages.forEach((stage, si) => {
    const x = padL + si * 100;
    const color = colors[si % colors.length];
    svg += `<rect x="${x}" y="${height - 15}" width="10" height="10" fill="${color}" rx="2"/>`;
    svg += `<text x="${x + 14}" y="${height - 6}" fill="#c9d1d9" font-size="10">${escHtml(stage)}</text>`;
  });

  svg += "</svg>";
  return svg;
}

/**
 * Format a WoW delta as colored text.
 */
function wowBadge(delta) {
  if (delta == null) return '<span style="color:#8b949e">—</span>';
  const sign = delta > 0 ? "+" : "";
  const color = delta > 0 ? "#f85149" : delta < 0 ? "#3fb950" : "#8b949e";
  return `<span style="color:${color};font-size:0.85em">${sign}${delta}% WoW</span>`;
}

/**
 * @deprecated Use the React app build pipeline instead (SYMPH-145).
 * Render self-contained HTML report from analysis JSON.
 */
function renderHtml(analysis) {
  const today = dateKey(new Date());
  const es = analysis.executive_summary ?? {};
  const sc = analysis.efficiency_scorecard ?? {};
  const perStageTrend = analysis.per_stage_trend ?? {};
  const perTicket = analysis.per_ticket_trend ?? {};
  const outliers = Array.isArray(analysis.outliers)
    ? analysis.outliers
    : (analysis.outliers?.items ?? []);
  const perStageSpend = analysis.per_stage_spend ?? {};
  const perProduct = analysis.per_product ?? {};
  const inflections = Array.isArray(analysis.inflections)
    ? analysis.inflections
    : (analysis.inflections?.items ?? []);

  // Compute tokens-per-issue median and mean from records
  const records = readJsonl(TOKEN_HISTORY_PATH);
  const issueTokens = {};
  for (const r of records) {
    const id = r.issue_identifier;
    if (!id) continue;
    issueTokens[id] = (issueTokens[id] ?? 0) + (r.total_total_tokens ?? 0);
  }
  const issueValues = Object.values(issueTokens);
  const tokensPerIssueMedian = median(issueValues);
  const tokensPerIssueMean = mean(issueValues);

  // Compute cache hit rate from efficiency scorecard
  const cacheHitRate = sc.cache_efficiency?.current ?? 0;

  // Build sparkline data for efficiency scorecard metrics (30-day daily)
  function buildDailyMetricSeries(metricFn) {
    const now = new Date();
    const vals = [];
    for (let i = 29; i >= 0; i--) {
      const dayStart = daysAgo(i + 1, now);
      const dayEnd = daysAgo(i, now);
      const dayRecords = filterByDateRange(records, dayStart, dayEnd);
      if (dayRecords.length > 0) {
        vals.push(metricFn(dayRecords));
      }
    }
    return vals;
  }

  const cacheEffSeries = buildDailyMetricSeries((recs) => {
    const sc2 = computeEfficiencyScorecard(recs);
    return sc2.cache_efficiency;
  });
  const outputRatioSeries = buildDailyMetricSeries((recs) => {
    const sc2 = computeEfficiencyScorecard(recs);
    return sc2.output_ratio;
  });
  const wastedCtxSeries = buildDailyMetricSeries((recs) => {
    const sc2 = computeEfficiencyScorecard(recs);
    return sc2.wasted_context;
  });
  const tokPerTurnSeries = buildDailyMetricSeries((recs) => {
    const sc2 = computeEfficiencyScorecard(recs);
    return sc2.tokens_per_turn;
  });
  const firstPassSeries = buildDailyMetricSeries((recs) => {
    const sc2 = computeEfficiencyScorecard(recs);
    return sc2.first_pass_rate;
  });
  const failureRateSeries = buildDailyMetricSeries((recs) => {
    const total = recs.length;
    const failed = recs.filter((r) => r.outcome === "failed").length;
    return total > 0 ? (failed / total) * 100 : 0;
  });

  // Per-ticket trend sparkline (rolling median by date)
  const perTicketSeries = (() => {
    const byDate = {};
    for (const r of records) {
      if (!r.issue_identifier) continue;
      const dk = dateKey(parseTs(r.timestamp));
      if (!byDate[dk]) byDate[dk] = {};
      byDate[dk][r.issue_identifier] =
        (byDate[dk][r.issue_identifier] ?? 0) + (r.total_total_tokens ?? 0);
    }
    const sortedDates = Object.keys(byDate).sort();
    return sortedDates.map((d) => median(Object.values(byDate[d])));
  })();

  // Config changes for multi-line chart
  const firstStageKey = Object.keys(perStageTrend)[0];
  const configChanges = firstStageKey
    ? (perStageTrend[firstStageKey].config_changes ?? [])
    : [];

  // Build issue leaderboard sorted by spend
  const leaderboard = Object.entries(issueTokens)
    .map(([id, tokens]) => {
      // Find title from records
      const rec = records.find((r) => r.issue_identifier === id);
      return { identifier: id, title: rec?.issue_title ?? "", tokens };
    })
    .sort((a, b) => b.tokens - a.tokens);

  // Per-stage sparklines
  const stageSparklines = {};
  for (const stage of Object.keys(perStageTrend)) {
    const dailyAvg = perStageTrend[stage].daily_avg ?? {};
    const sortedDates = Object.keys(dailyAvg).sort();
    stageSparklines[stage] = sortedDates.map((d) => dailyAvg[d]);
  }

  // WoW deltas for KPIs
  const tokensDelta = es.total_tokens?.wow_delta_pct;
  const stagesDelta = es.total_stages?.wow_delta_pct;

  // Compute tokens-per-issue WoW delta
  const tokPerIssueWow = (() => {
    if (records.length === 0) return null;
    const now = new Date();
    const d7 = daysAgo(7, now);
    const d14 = daysAgo(14, now);
    const curr = filterByDateRange(records, d7, now);
    const prev = filterByDateRange(records, d14, d7);
    if (curr.length === 0 || prev.length === 0) return null;
    const currIssues = {};
    for (const r of curr) {
      if (r.issue_identifier)
        currIssues[r.issue_identifier] =
          (currIssues[r.issue_identifier] ?? 0) + (r.total_total_tokens ?? 0);
    }
    const prevIssues = {};
    for (const r of prev) {
      if (r.issue_identifier)
        prevIssues[r.issue_identifier] =
          (prevIssues[r.issue_identifier] ?? 0) + (r.total_total_tokens ?? 0);
    }
    const currMedian = median(Object.values(currIssues));
    const prevMedian = median(Object.values(prevIssues));
    if (prevMedian === 0) return null;
    return round(((currMedian - prevMedian) / prevMedian) * 100, 1);
  })();

  // Cache hit rate WoW delta
  const cacheWow = (() => {
    const now = new Date();
    const d7 = daysAgo(7, now);
    const d14 = daysAgo(14, now);
    const curr = filterByDateRange(records, d7, now);
    const prev = filterByDateRange(records, d14, d7);
    if (curr.length === 0 || prev.length === 0) return null;
    const currSc = computeEfficiencyScorecard(curr);
    const prevSc = computeEfficiencyScorecard(prev);
    if (prevSc.cache_efficiency === 0) return null;
    return round(
      ((currSc.cache_efficiency - prevSc.cache_efficiency) /
        prevSc.cache_efficiency) *
        100,
      1,
    );
  })();

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Symphony Token Report — ${escHtml(today)}</title>
<style>
  :root {
    --bg: #0d1117;
    --bg-card: #161b22;
    --border: #30363d;
    --text: #c9d1d9;
    --text-muted: #8b949e;
    --text-bright: #f0f6fc;
    --accent: #58a6ff;
    --green: #3fb950;
    --red: #f85149;
    --yellow: #d29922;
    --purple: #bc8cff;
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif;
    background: var(--bg);
    color: var(--text);
    line-height: 1.5;
    padding: 24px;
    max-width: 1200px;
    margin: 0 auto;
  }
  h1 { color: var(--text-bright); margin-bottom: 8px; font-size: 1.5rem; }
  h2 {
    color: var(--text-bright);
    font-size: 1.2rem;
    margin: 32px 0 16px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--border);
  }
  .subtitle { color: var(--text-muted); font-size: 0.9rem; margin-bottom: 24px; }
  .kpi-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 16px;
    margin-bottom: 24px;
  }
  .kpi-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 16px;
  }
  .kpi-label { color: var(--text-muted); font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.05em; }
  .kpi-value { color: var(--text-bright); font-size: 1.6rem; font-weight: 600; margin: 4px 0; }
  .kpi-delta { font-size: 0.85rem; }
  .metric-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 6px;
    margin-bottom: 8px;
  }
  .metric-name { color: var(--text); font-weight: 500; min-width: 140px; }
  .metric-value { color: var(--text-bright); font-weight: 600; min-width: 60px; text-align: right; }
  .metric-sparkline { margin-left: 16px; }
  .chart-container {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 16px;
    margin-bottom: 16px;
    overflow-x: auto;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    margin-bottom: 16px;
  }
  th {
    text-align: left;
    color: var(--text-muted);
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
  }
  td {
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    color: var(--text);
  }
  tr:hover td { background: rgba(88,166,255,0.04); }
  .outlier-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 16px;
    margin-bottom: 12px;
  }
  .outlier-title { color: var(--accent); font-weight: 600; }
  .outlier-hypothesis { color: var(--text-muted); font-size: 0.9rem; margin-top: 4px; }
  .stage-card {
    background: var(--bg-card);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 16px;
    margin-bottom: 12px;
  }
  .stage-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
  .stage-name { color: var(--text-bright); font-weight: 600; }
  .inflection-panel {
    background: rgba(210,153,34,0.1);
    border: 1px solid var(--yellow);
    border-radius: 6px;
    padding: 12px 16px;
    margin-bottom: 12px;
  }
  .inflection-panel .label { color: var(--yellow); font-weight: 600; font-size: 0.85rem; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; }
  .product-bar {
    height: 8px;
    border-radius: 4px;
    background: var(--accent);
    margin-top: 4px;
  }
  footer { color: var(--text-muted); font-size: 0.8rem; margin-top: 40px; text-align: center; }
</style>
</head>
<body>
<h1>Symphony Token Report</h1>
<p class="subtitle">Generated ${escHtml(today)} · ${fmtNum(analysis.record_count ?? 0)} records · ${analysis.data_span_days ?? 0} day span</p>

<!-- Section 1: Executive Summary -->
<h2>Executive Summary</h2>
<div class="kpi-grid">
  <div class="kpi-card">
    <div class="kpi-label">Total Tokens</div>
    <div class="kpi-value">${fmtNum(es.total_tokens?.value)}</div>
    <div class="kpi-delta">${wowBadge(tokensDelta)}</div>
  </div>
  <div class="kpi-card">
    <div class="kpi-label">Tokens / Issue (median)</div>
    <div class="kpi-value">${fmtNum(tokensPerIssueMedian)}</div>
    <div class="kpi-delta">mean: ${fmtNum(tokensPerIssueMean)} ${wowBadge(tokPerIssueWow)}</div>
  </div>
  <div class="kpi-card">
    <div class="kpi-label">Issues Processed</div>
    <div class="kpi-value">${fmtNum(es.unique_issues?.value)}</div>
  </div>
  <div class="kpi-card">
    <div class="kpi-label">Cache Hit Rate</div>
    <div class="kpi-value">${round(cacheHitRate, 1)}%</div>
    <div class="kpi-delta">${wowBadge(cacheWow)}</div>
  </div>
</div>

<!-- Section 2: Efficiency Scorecard -->
<h2>Efficiency Scorecard</h2>
<div class="metric-row">
  <span class="metric-name">Cache Efficiency</span>
  <span class="metric-value">${round(sc.cache_efficiency?.current ?? 0, 1)}%</span>
  <span class="metric-sparkline">${sparklineSvg(cacheEffSeries)}</span>
</div>
<div class="metric-row">
  <span class="metric-name">Output Ratio</span>
  <span class="metric-value">${round(sc.output_ratio?.current ?? 0, 1)}%</span>
  <span class="metric-sparkline">${sparklineSvg(outputRatioSeries, { stroke: "#3fb950" })}</span>
</div>
<div class="metric-row">
  <span class="metric-name">Wasted Context</span>
  <span class="metric-value">${round(sc.wasted_context?.current ?? 0, 1)}%</span>
  <span class="metric-sparkline">${sparklineSvg(wastedCtxSeries, { stroke: "#d29922" })}</span>
</div>
<div class="metric-row">
  <span class="metric-name">Tokens / Turn</span>
  <span class="metric-value">${fmtNum(sc.tokens_per_turn?.current ?? 0)}</span>
  <span class="metric-sparkline">${sparklineSvg(tokPerTurnSeries, { stroke: "#bc8cff" })}</span>
</div>
<div class="metric-row">
  <span class="metric-name">First-Pass Rate</span>
  <span class="metric-value">${round(sc.first_pass_rate?.current ?? 0, 1)}%</span>
  <span class="metric-sparkline">${sparklineSvg(firstPassSeries, { stroke: "#56d364" })}</span>
</div>
<div class="metric-row">
  <span class="metric-name">Failure Rate (all stages)</span>
  <span class="metric-value">${(() => {
    const fr = sc.failure_rate?.current ?? {};
    const rates = Object.values(fr);
    return rates.length > 0 ? `${round(mean(rates), 1)}%` : "0%";
  })()}</span>
  <span class="metric-sparkline">${sparklineSvg(failureRateSeries, { stroke: "#f85149" })}</span>
</div>

<!-- Section 3: Per-Stage Utilization Trend -->
<h2>Per-Stage Utilization Trend</h2>
<div class="chart-container">
${multiLineSvg(perStageTrend, configChanges)}
${
  inflections.length > 0
    ? inflections
        .map(
          (inf) => `
<div class="inflection-panel">
  <div class="label">⚡ Inflection: ${escHtml(inf.metric)} — ${escHtml(inf.direction)} ${round(inf.magnitude * 100, 1)}%</div>
  <div style="color:var(--text-muted);font-size:0.85rem;margin-top:4px">7d avg: ${fmtNum(inf.avg_7d)} · 30d avg: ${fmtNum(inf.avg_30d)}${inf.context ? ` · ${escHtml(inf.context)}` : ""}${inf.llm_insight ? `<br/>💡 ${escHtml(inf.llm_insight)}` : ""}</div>
</div>`,
        )
        .join("")
    : ""
}
</div>

<!-- Section 4: Per-Ticket Cost Trend -->
<h2>Per-Ticket Cost Trend</h2>
<div class="chart-container">
  <div style="margin-bottom:8px;color:var(--text-muted);font-size:0.85rem">Rolling median tokens per ticket · median: ${fmtNum(perTicket.median)} · mean: ${fmtNum(perTicket.mean)} · ${perTicket.ticket_count} tickets</div>
  ${sparklineSvg(perTicketSeries, { width: 580, height: 60, stroke: "#58a6ff", strokeWidth: 2 })}
</div>

<!-- Section 5: Outlier Analysis -->
<h2>Outlier Analysis</h2>
${
  outliers.length === 0
    ? '<p style="color:var(--text-muted)">No outliers detected (>2σ threshold)</p>'
    : outliers
        .map(
          (o) => `
<div class="outlier-card">
  <div class="outlier-title"><a href="https://linear.app/issue/${escHtml(o.issue_identifier)}" target="_blank">${escHtml(o.issue_identifier)}</a> — ${escHtml(o.issue_title)} — ${fmtNum(o.total_tokens)} tokens (z=${o.z_score})</div>
  <div class="outlier-hypothesis">${escHtml(o.hypothesis ?? "No hypothesis available")}</div>
  ${o.parent ? `<div style="color:var(--text-muted);font-size:0.85rem;margin-top:4px">Parent: ${escHtml(o.parent.identifier)} (${escHtml(o.parent.complexity)}, ${o.parent.task_count} tasks)</div>` : ""}
</div>`,
        )
        .join("")
}

<!-- Section 6: Issue Leaderboard -->
<h2>Issue Leaderboard</h2>
<table>
  <thead><tr><th>#</th><th>Issue</th><th>Title</th><th style="text-align:right">Tokens</th></tr></thead>
  <tbody>
${leaderboard
  .slice(0, 25)
  .map(
    (item, i) =>
      `    <tr><td>${i + 1}</td><td><a href="https://linear.app/issue/${escHtml(item.identifier)}" target="_blank">${escHtml(item.identifier)}</a></td><td>${escHtml(item.title)}</td><td style="text-align:right">${fmtNum(item.tokens)}</td></tr>`,
  )
  .join("\n")}
  </tbody>
</table>

<!-- Section 7: Stage Efficiency -->
<h2>Stage Efficiency</h2>
${Object.entries(perStageSpend)
  .map(
    ([stage, data]) => `
<div class="stage-card">
  <div class="stage-header">
    <span class="stage-name">${escHtml(stage)}</span>
    <span style="color:var(--text-muted)">${fmtNum(data.total_tokens)} tokens · ${data.count} runs · ${data.completed} ok · ${data.failed} fail</span>
  </div>
  <div style="display:flex;align-items:center;gap:8px">
    <span style="color:var(--text-muted);font-size:0.85rem">30d trend:</span>
    ${sparklineSvg(stageSparklines[stage] ?? [], { stroke: "#58a6ff" })}
  </div>
</div>`,
  )
  .join("")}

<!-- Section 8: Per-Product Breakdown -->
<h2>Per-Product Breakdown</h2>
<table>
  <thead><tr><th>Product</th><th style="text-align:right">Tokens</th><th style="text-align:right">Stages</th><th style="text-align:right">Issues</th><th>Share</th></tr></thead>
  <tbody>
${(() => {
  const totalTokens =
    Object.values(perProduct).reduce((s, p) => s + (p.total_tokens ?? 0), 0) ||
    1;
  return Object.entries(perProduct)
    .sort((a, b) => (b[1].total_tokens ?? 0) - (a[1].total_tokens ?? 0))
    .map(([name, data]) => {
      const pct = round((data.total_tokens / totalTokens) * 100, 1);
      return `    <tr><td>${escHtml(name)}</td><td style="text-align:right">${fmtNum(data.total_tokens)}</td><td style="text-align:right">${data.total_stages}</td><td style="text-align:right">${data.unique_issues}</td><td><div class="product-bar" style="width:${pct}%"></div> ${pct}%</td></tr>`;
    })
    .join("\n");
})()}
  </tbody>
</table>

<footer>Symphony Token Report · Self-contained · Generated by token-report.mjs · SYMPH-131</footer>
</body>
</html>`;

  return html;
}

/**
 * Render subcommand: generate HTML report file.
 */
function runRender() {
  const analysis = computeAnalysis();
  const html = renderHtml(analysis);
  const today = dateKey(new Date());
  const outPath = join(REPORTS_DIR, `${today}.html`);
  mkdirSync(REPORTS_DIR, { recursive: true });
  writeFileSync(outPath, html);
  info(`Report written to ${outPath}`);
}

// ---------------------------------------------------------------------------
// Concern-flag helper — SYMPH-152
// ---------------------------------------------------------------------------

/**
 * Build an array of narrative concern strings based on scorecard thresholds.
 * Returns empty array when all metrics are healthy.
 *
 * Thresholds:
 *   - stage failure >20%    (any stage in failure_rate.current)
 *   - tokens/turn >100K     (tokens_per_turn.current)
 *   - cache <50%            (cache_efficiency.current)
 *   - first-pass <70%       (first_pass_rate.current)
 *   - wasted context >10%   (wasted_context.current)
 */
function buildConcerns(scorecard) {
  const concerns = [];

  // Check per-stage failure rates
  const failureRates = scorecard?.failure_rate?.current;
  if (failureRates && typeof failureRates === "object") {
    for (const [stage, rate] of Object.entries(failureRates)) {
      if (rate > 20) {
        concerns.push(
          `⚠️ Stage *${stage}* failure rate is ${round(rate, 1)}% (threshold: 20%)`,
        );
      }
    }
  }

  // Tokens per turn
  const tpt = scorecard?.tokens_per_turn?.current ?? 0;
  if (tpt > 100000) {
    concerns.push(`⚠️ Tokens/turn is *${fmtNum(tpt)}* (threshold: 100K)`);
  }

  // Cache efficiency
  const cache = scorecard?.cache_efficiency?.current ?? 100;
  if (cache < 50) {
    concerns.push(`⚠️ Cache hit rate is *${round(cache, 1)}%* (threshold: 50%)`);
  }

  // First-pass success rate
  const fp = scorecard?.first_pass_rate?.current ?? 100;
  if (fp < 70) {
    concerns.push(
      `⚠️ First-pass success is *${round(fp, 1)}%* (threshold: 70%)`,
    );
  }

  // Wasted context
  const wc = scorecard?.wasted_context?.current ?? 0;
  if (wc > 10) {
    concerns.push(`⚠️ Wasted context is *${round(wc, 1)}%* (threshold: 10%)`);
  }

  return concerns;
}

// ---------------------------------------------------------------------------
// Slack subcommand — SYMPH-131
// ---------------------------------------------------------------------------

/**
 * Post narrative Slack digest via Bot Token API (SYMPH-139).
 *
 * 9-section markdown digest with interpretive commentary.
 * Set DRY_RUN=1 to log to stderr instead of posting.
 */
function runSlack() {
  const botToken = process.env.SLACK_BOT_TOKEN;
  if (!botToken) {
    warn("SLACK_BOT_TOKEN not set — skipping Slack digest");
    return;
  }
  const channelId = process.env.SLACK_CHANNEL_ID || "C0ANRJRBYGL";

  const analysis = computeAnalysis();
  const es = analysis.executive_summary ?? {};
  const sc = analysis.efficiency_scorecard ?? {};
  const outliers = Array.isArray(analysis.outliers)
    ? analysis.outliers
    : (analysis.outliers?.items ?? []);
  const inflections = Array.isArray(analysis.inflections)
    ? analysis.inflections
    : (analysis.inflections?.items ?? []);
  const perStageSpend = analysis.per_stage_spend ?? {};
  const perProduct = analysis.per_product ?? {};
  const perTicket = analysis.per_ticket_trend ?? {};

  // Compute tokens-per-issue
  const records = readJsonl(TOKEN_HISTORY_PATH);
  const issueTokens = {};
  for (const r of records) {
    if (r.issue_identifier)
      issueTokens[r.issue_identifier] =
        (issueTokens[r.issue_identifier] ?? 0) + (r.total_total_tokens ?? 0);
  }
  const issueValues = Object.values(issueTokens);
  const medianTPI = fmtNum(median(issueValues));
  const meanTPI = fmtNum(mean(issueValues));

  // Top consumer
  let topConsumer = "—";
  if (issueValues.length > 0) {
    const sorted = Object.entries(issueTokens).sort((a, b) => b[1] - a[1]);
    topConsumer = `${sorted[0][0]} (${fmtNum(sorted[0][1])})`;
  }

  // Report link — always use BASE_URL env var; no hardcoded hostname fallback
  const reportPort = process.env.TOKEN_REPORT_PORT || "8090";
  let rawBase = process.env.BASE_URL || `localhost:${reportPort}`;
  // Strip protocol prefix if present so we can prepend http:// uniformly
  rawBase = rawBase.replace(/^https?:\/\//, "").replace(/\/+$/, "");
  const today = dateKey(new Date());
  const reportUrl = `http://${rawBase}/${today}.html`;

  // --- Section 1: Title ---
  const sections = [];
  sections.push(`*🎵 Symphony Token Digest — ${today}*`);

  // --- Section 2: Executive Summary ---
  const spanDays = analysis.data_span_days ?? 0;
  const tier = analysis.cold_start_tier ?? "unknown";
  const coldStart = spanDays < 7;
  let execSummary = `*Executive Summary*\n> *${fmtNum(es.total_tokens?.value)}* tokens across *${fmtNum(es.unique_issues?.value)}* issues over *${spanDays}d* (tier: ${tier})\n> ${fmtNum(es.total_stages?.value ?? 0)} total stages completed`;
  if (coldStart) {
    execSummary +=
      "\n> _⚠️ Cold start — less than 7d of data; WoW deltas not available_";
  }
  sections.push(execSummary);

  // --- Section 3: Tokens per Issue ---
  sections.push(
    `*Tokens per Issue*\n> Median: *${medianTPI}* · Mean: *${meanTPI}* · Issues tracked: *${issueValues.length}*\n> Top consumer: *${topConsumer}*\n${
      perTicket.ticket_count > 0
        ? `> Rolling trend — median: ${fmtNum(perTicket.median)}, mean: ${fmtNum(perTicket.mean)}`
        : "> _No rolling trend data yet_"
    }`,
  );

  // --- Section 4: Efficiency Scorecard ---
  const cacheEff = round(sc.cache_efficiency?.current ?? 0, 1);
  const cacheTrend7d = round(sc.cache_efficiency?.trend_7d ?? 0, 1);
  const outputRatio = round(sc.output_ratio?.current ?? 0, 1);
  const firstPass = round(sc.first_pass_rate?.current ?? 0, 1);
  const tokPerTurn = fmtNum(sc.tokens_per_turn?.current ?? 0);
  const wastedCtx = round(sc.wasted_context?.current ?? 0, 1);
  sections.push(
    `*Efficiency Scorecard*\n> Cache hit rate: *${cacheEff}%* (7d trend: ${cacheTrend7d >= 0 ? "+" : ""}${cacheTrend7d}%)\n> Output ratio: *${outputRatio}%* · First-pass success: *${firstPass}%*\n> Tokens/turn: *${tokPerTurn}* · Wasted context: *${wastedCtx}%*`,
  );

  // --- Section 4b: Concerns (narrative commentary) — SYMPH-152 ---
  const concerns = buildConcerns(sc);
  if (concerns.length > 0) {
    sections.push(`*Concerns*\n${concerns.map((c) => `> ${c}`).join("\n")}`);
  } else {
    sections.push("*Concerns*\n> ✅ All metrics within healthy thresholds");
  }

  // --- Section 5: Per-Stage Spend ---
  const stageEntries = Object.entries(perStageSpend);
  if (stageEntries.length > 0) {
    const stageLines = stageEntries
      .sort((a, b) => (b[1]?.total_tokens ?? 0) - (a[1]?.total_tokens ?? 0))
      .slice(0, 5)
      .map(
        ([stage, data]) =>
          `>  • ${stage}: *${fmtNum(data?.total_tokens ?? 0)}* tokens (${fmtNum(data?.count ?? 0)} stages)`,
      );
    sections.push(`*Per-Stage Spend (top 5)*\n${stageLines.join("\n")}`);
  } else {
    sections.push("*Per-Stage Spend*\n> _No stage data available_");
  }

  // --- Section 6: Per-Product Breakdown ---
  const productEntries = Object.entries(perProduct);
  if (productEntries.length > 0) {
    const productLines = productEntries
      .sort((a, b) => (b[1]?.total_tokens ?? 0) - (a[1]?.total_tokens ?? 0))
      .slice(0, 5)
      .map(
        ([product, data]) =>
          `>  • ${product}: *${fmtNum(data?.total_tokens ?? 0)}* tokens (${fmtNum(data?.total_stages ?? 0)} stages)`,
      );
    sections.push(
      `*Per-Product Breakdown (top 5)*\n${productLines.join("\n")}`,
    );
  } else {
    sections.push("*Per-Product Breakdown*\n> _No product data available_");
  }

  // --- Section 7: Outliers ---
  if (outliers.length > 0) {
    const outlierLines = outliers
      .slice(0, 5)
      .map(
        (o) =>
          `>  • ⚠️ ${o.issue_identifier}: *${fmtNum(o.total_tokens)}* tokens (z=${round(o.z_score, 2)})${o.hypothesis ? ` — ${o.hypothesis}` : ""}`,
      );
    sections.push(
      `*Outliers* (>${"2σ"} from mean)\n${outlierLines.join("\n")}`,
    );
  } else {
    sections.push(
      "*Outliers*\n> ✅ No outliers detected — all issues within 2σ of mean",
    );
  }

  // --- Section 8: Inflections ---
  if (inflections.length > 0) {
    const inflectionLines = inflections
      .slice(0, 5)
      .map(
        (inf) =>
          `>  • ⚡ ${inf.metric}: ${inf.direction} *${round(inf.magnitude * 100, 1)}%* (7d avg crossed 30d avg)`,
      );
    sections.push(`*Trend Inflections*\n${inflectionLines.join("\n")}`);
  } else {
    sections.push(
      `*Trend Inflections*\n> _No inflection points detected${spanDays < 30 ? " (requires ≥30d of data)" : ""}_`,
    );
  }

  // --- Section 9: Report Link ---
  sections.push(`📊 <${reportUrl}|View full HTML report>`);

  const message = sections.join("\n\n");

  // DRY_RUN support: log to stderr instead of posting
  if (process.env.DRY_RUN) {
    process.stderr.write(`[DRY_RUN] Slack digest message:\n${message}\n`);
    info("DRY_RUN set — Slack digest logged to stderr, not posted");
    return;
  }

  const payload = JSON.stringify({ channel: channelId, text: message });

  try {
    const response = execFileSync(
      "curl",
      [
        "-s",
        "-X",
        "POST",
        "https://slack.com/api/chat.postMessage",
        "-H",
        `Authorization: Bearer ${botToken}`,
        "-H",
        "Content-type: application/json; charset=utf-8",
        "-d",
        payload,
      ],
      {
        encoding: "utf-8",
        timeout: 30000,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let parsed;
    try {
      parsed = JSON.parse(response);
    } catch {
      warn(`Slack post returned non-JSON response: ${response.slice(0, 200)}`);
      return;
    }
    if (parsed.ok) {
      info("Slack digest posted");
    } else {
      warn(`Slack API error: ${parsed.error ?? "unknown"}`);
    }
  } catch (err) {
    warn(`Slack post failed: ${err.message}`);
    // Graceful degradation: don't throw
  }
}

// ---------------------------------------------------------------------------
// Rotate subcommand — SYMPH-131
// ---------------------------------------------------------------------------

import {
  createReadStream,
  createWriteStream,
  unlinkSync,
  utimesSync,
} from "node:fs";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

/**
 * Log rotation: compress/delete old JSONL logs and HTML reports.
 *
 * Raw JSONL: compress >7d, delete >14d, skip mtime <2h
 * HTML reports: delete >90d
 *
 * Replaces com.symphony.newsyslog.conf for symphony logs.
 */
async function runRotate() {
  const now = Date.now();
  const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
  const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
  const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;
  const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;

  // Rotate JSONL files in data dir
  if (existsSync(DATA_DIR)) {
    const files = readdirSync(DATA_DIR);
    for (const file of files) {
      const filePath = join(DATA_DIR, file);
      let st;
      try {
        st = statSync(filePath);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;

      const age = now - st.mtimeMs;

      // Safety: never touch files modified less than 2 hours ago
      if (age < TWO_HOURS_MS) continue;

      // Delete compressed files older than 14 days
      if (file.endsWith(".jsonl.gz") && age > FOURTEEN_DAYS_MS) {
        info(`Deleting old compressed log: ${file}`);
        unlinkSync(filePath);
        continue;
      }

      // Compress JSONL files older than 7 days
      if (file.endsWith(".jsonl") && age > SEVEN_DAYS_MS) {
        info(`Compressing old log: ${file}`);
        const gzPath = `${filePath}.gz`;
        try {
          await pipeline(
            createReadStream(filePath),
            createGzip(),
            createWriteStream(gzPath),
          );
          // Preserve mtime on compressed file
          utimesSync(gzPath, st.atime, st.mtime);
          unlinkSync(filePath);
        } catch (err) {
          warn(`Failed to compress ${file}: ${err.message}`);
        }
      }
    }
  }

  // Delete old HTML reports
  if (existsSync(REPORTS_DIR)) {
    const files = readdirSync(REPORTS_DIR);
    for (const file of files) {
      if (!file.endsWith(".html")) continue;
      const filePath = join(REPORTS_DIR, file);
      let st;
      try {
        st = statSync(filePath);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      const age = now - st.mtimeMs;
      if (age > NINETY_DAYS_MS) {
        info(`Deleting old report: ${file}`);
        unlinkSync(filePath);
      }
    }
  }

  info("Log rotation complete");
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function ensureDirs(...dirs) {
  for (const dir of dirs) {
    mkdirSync(dir, { recursive: true });
  }
}

const subcommand = process.argv[2];

if (!subcommand || subcommand === "extract") {
  ensureDirs(
    DATA_DIR,
    HWM_DIR,
    LINEAR_CACHE_DIR,
    join(SYMPHONY_HOME, "logs"),
    REPORTS_DIR,
  );
  runExtract();
} else if (subcommand === "analyze") {
  ensureDirs(DATA_DIR, LINEAR_CACHE_DIR);
  runAnalyze();
} else if (subcommand === "render") {
  ensureDirs(DATA_DIR, LINEAR_CACHE_DIR, REPORTS_DIR);
  runRender();
} else if (subcommand === "slack") {
  ensureDirs(DATA_DIR, LINEAR_CACHE_DIR);
  runSlack();
} else if (subcommand === "rotate") {
  runRotate().catch((err) => {
    process.stderr.write(`ERROR: rotate failed: ${err.message}\n`);
    process.exit(1);
  });
} else {
  process.stderr.write(
    `Unknown subcommand: ${subcommand}\nUsage: token-report.mjs [extract|analyze|render|slack|rotate]\n`,
  );
  process.exit(1);
}
