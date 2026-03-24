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
// TODO: analyze subcommand — covered by separate task
// ---------------------------------------------------------------------------

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
  // TODO: analyze subcommand — SYMPH-129 config change detection (separate scope)
  warn("analyze subcommand not yet implemented");
  process.exit(0);
} else {
  process.stderr.write(
    `Unknown subcommand: ${subcommand}\nUsage: token-report.mjs [extract|analyze]\n`,
  );
  process.exit(1);
}
