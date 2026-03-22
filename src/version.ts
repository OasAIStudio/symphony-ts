import { execSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * The calver version string read from package.json at runtime.
 */
export const VERSION: string = (
  require("../package.json") as { version: string }
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
