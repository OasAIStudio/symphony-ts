#!/usr/bin/env node
/**
 * Thin vitest wrapper that maps --grep <pattern> to vitest's -t <pattern>,
 * so that `npm test -- --grep "..."` works as expected (mocha-compatible CLI).
 */
import { spawnSync } from "node:child_process";

const args = process.argv.slice(2);
const translated = [];

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--grep" && i + 1 < args.length) {
    translated.push("-t", args[++i]);
  } else {
    translated.push(args[i]);
  }
}

const result = spawnSync("vitest", ["run", ...translated], {
  stdio: "inherit",
});
process.exit(result.status ?? 1);
