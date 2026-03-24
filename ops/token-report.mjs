#!/usr/bin/env node
/**
 * token-report.mjs — Token history extraction + JSONL persistence
 *
 * Subcommands:
 *   extract  — Parse symphony.jsonl logs, extract stage_completed events,
 *              enrich with Linear issue titles, append to token-history.jsonl
 *
 * Environment:
 *   SYMPHONY_HOME    (default $HOME/.symphony)
 *   SYMPHONY_LOG_DIR (default $HOME/Library/Logs/symphony)
 *   LINEAR_API_KEY   — used by `linear` CLI; graceful degradation without it
 *
 * SYMPH-129
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
 * Main analyze function.
 */
function runAnalyze() {
  const records = readJsonl(TOKEN_HISTORY_PATH);
  const configRecords = readJsonl(CONFIG_HISTORY_PATH);

  if (records.length === 0) {
    const result = {
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
      per_stage_trend: {},
      per_ticket_trend: { median: 0, mean: 0, ticket_count: 0 },
      per_product: {},
      inflections: [],
      outliers: [],
    };
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  const spanDays = dataSpanDays(records);
  const tier = coldStartTier(spanDays);
  const now = new Date();

  const isColdStart = spanDays < 7;

  const scorecard = computeScorecardWithTrends(records, now);
  const executiveSummary = buildExecutiveSummary(records, spanDays, now);
  const perStageSpend = computePerStageSpend(records);
  const perStageTrend = computePerStageTrend(records, configRecords);
  const perTicketTrend = computePerTicketTrend(records);
  const perProduct = computePerProduct(records);

  // Inflection detection and outliers: only meaningful with sufficient data
  let inflections = [];
  let outliers = [];

  if (tier === ">=30d") {
    inflections = detectInflections(records, configRecords, now);
    outliers = detectOutliers(records);
  } else if (tier === "7-29d") {
    outliers = detectOutliers(records);
    inflections = [];
  }

  const result = {
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
    per_stage_trend: perStageTrend,
    per_ticket_trend: perTicketTrend,
    per_product: perProduct,
    inflections:
      tier === "<7d" ? { status: "insufficient data", items: [] } : inflections,
    outliers:
      tier === "<7d" ? { status: "insufficient data", items: [] } : outliers,
  };

  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const subcommand = process.argv[2];

if (!subcommand || subcommand === "extract") {
  // Ensure directories exist
  for (const dir of [
    DATA_DIR,
    HWM_DIR,
    LINEAR_CACHE_DIR,
    join(SYMPHONY_HOME, "logs"),
    join(SYMPHONY_HOME, "reports"),
  ]) {
    mkdirSync(dir, { recursive: true });
  }
  runExtract();
} else if (subcommand === "analyze") {
  // Ensure directories exist
  for (const dir of [DATA_DIR, LINEAR_CACHE_DIR]) {
    mkdirSync(dir, { recursive: true });
  }
  runAnalyze();
} else {
  process.stderr.write(
    `Unknown subcommand: ${subcommand}\nUsage: token-report.mjs [extract|analyze]\n`,
  );
  process.exit(1);
}
