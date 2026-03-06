import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ERROR_CODES } from "../../src/errors/codes.js";
import {
  type WorkspacePathError,
  assertWorkspacePathWithinRoot,
  resolveWorkspacePath,
  sanitizeWorkspaceKey,
  validateWorkspaceCwd,
} from "../../src/workspace/path-safety.js";

describe("workspace path safety", () => {
  it("sanitizes issue identifiers into deterministic workspace keys", () => {
    expect(sanitizeWorkspaceKey("ABC-123/needs review")).toBe(
      "ABC-123_needs_review",
    );
    expect(sanitizeWorkspaceKey("你好 world")).toBe("___world");
  });

  it("builds an absolute workspace path under the configured root", () => {
    const info = resolveWorkspacePath(
      "./tmp/workspaces",
      "ABC-123/needs review",
    );

    expect(info.workspaceKey).toBe("ABC-123_needs_review");
    expect(info.workspacePath).toBe(
      join(info.workspaceRoot, "ABC-123_needs_review"),
    );
  });

  it("rejects empty workspace keys and paths outside the root", () => {
    expect(() => resolveWorkspacePath("/tmp/symphony", "")).toThrowError(
      expect.objectContaining({
        code: ERROR_CODES.workspacePathInvalid,
      }),
    );

    expect(() =>
      assertWorkspacePathWithinRoot("/tmp/symphony", "/tmp/other/ABC-123"),
    ).toThrowError(
      expect.objectContaining({
        code: ERROR_CODES.workspaceRootEscape,
      }),
    );
  });

  it("rejects agent cwd values that do not match the workspace path", () => {
    expect(() =>
      validateWorkspaceCwd({
        workspaceRoot: "/tmp/symphony",
        workspacePath: "/tmp/symphony/ABC-123",
        cwd: "/tmp/symphony/other",
      }),
    ).toThrowError(
      expect.objectContaining<Partial<WorkspacePathError>>({
        code: ERROR_CODES.invalidWorkspaceCwd,
      }),
    );
  });
});
