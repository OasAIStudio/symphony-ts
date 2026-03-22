import { createRequire } from "node:module";
import { beforeEach, describe, expect, it } from "vitest";

import {
  VERSION,
  _resetGitShaCache,
  getDisplayVersion,
} from "../src/version.js";

const require = createRequire(import.meta.url);

describe("version module", () => {
  beforeEach(() => {
    _resetGitShaCache();
  });

  it("VERSION matches package.json", () => {
    const pkg = require("../package.json") as { version: string };
    expect(VERSION).toBe(pkg.version);
  });

  it("display version includes git SHA", () => {
    const display = getDisplayVersion();
    // In a git repo, should be VERSION+7-char-hex
    expect(display).toMatch(
      new RegExp(`^${VERSION.replace(/\./g, "\\.")}\\+[0-9a-f]{7}$`),
    );
  });

  it("caches git SHA across calls", () => {
    const first = getDisplayVersion();
    const second = getDisplayVersion();
    expect(first).toBe(second);
  });
});
