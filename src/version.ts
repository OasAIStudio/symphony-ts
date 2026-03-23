import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

/**
 * Resolve the path to the project-root package.json.
 * Works from both src/version.ts and dist/src/version.js.
 */
function findPackageJson(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = resolve(dir, "package.json");
    if (existsSync(candidate)) {
      return candidate;
    }
    dir = dirname(dir);
  }
  // Fallback — let createRequire throw a clear error if missing.
  return resolve(dirname(fileURLToPath(import.meta.url)), "../package.json");
}

/**
 * The calver version string read from package.json at runtime.
 */
export const VERSION: string = (
  require(findPackageJson()) as { version: string }
).version;

let cachedGitSha: string | undefined;
let gitShaResolved = false;

function resolveGitSha(): string | undefined {
  if (gitShaResolved) {
    return cachedGitSha;
  }
  gitShaResolved = true;
  try {
    const sha = execSync("git rev-parse --short=7 HEAD", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    }).trim();
    if (/^[0-9a-f]{7}$/.test(sha)) {
      cachedGitSha = sha;
    }
  } catch {
    // git not available or not a git repo — leave undefined
  }
  return cachedGitSha;
}

/**
 * Returns a display version string including the git SHA suffix when available.
 * Format: "VERSION+SHA" (e.g. "0.1.8+abc1234") or just "VERSION" if git is unavailable.
 */
export function getDisplayVersion(): string {
  const sha = resolveGitSha();
  return sha ? `${VERSION}+${sha}` : VERSION;
}

/**
 * Reset cached git SHA — only for testing purposes.
 * @internal
 */
export function _resetGitShaCache(): void {
  cachedGitSha = undefined;
  gitShaResolved = false;
}
