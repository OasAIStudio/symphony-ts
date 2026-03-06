import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { ERROR_CODES } from "../../src/errors/codes.js";
import { WorkspaceManager, type WorkspacePathError } from "../../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    roots.splice(0).map(async (root) => {
      const manager = new WorkspaceManager({ root });
      await manager.removeForIssue("ABC-123");
      await manager.removeForIssue("ABC-123/needs review");
    }),
  );
});

describe("WorkspaceManager", () => {
  it("creates a missing workspace directory with a deterministic path", async () => {
    const root = await createRoot();
    const manager = new WorkspaceManager({ root });

    const workspace = await manager.createForIssue("ABC-123/needs review");

    expect(workspace.workspaceKey).toBe("ABC-123_needs_review");
    expect(workspace.path).toBe(join(root, "ABC-123_needs_review"));
    expect(workspace.createdNow).toBe(true);
  });

  it("reuses an existing workspace directory on later attempts", async () => {
    const root = await createRoot();
    const manager = new WorkspaceManager({ root });

    await manager.createForIssue("ABC-123");
    const workspace = await manager.createForIssue("ABC-123");

    expect(workspace.path).toBe(join(root, "ABC-123"));
    expect(workspace.createdNow).toBe(false);
  });

  it("fails safely when the workspace path already exists as a file", async () => {
    const root = await createRoot();
    await writeFile(join(root, "ABC-123"), "not a directory");
    const manager = new WorkspaceManager({ root });

    await expect(manager.createForIssue("ABC-123")).rejects.toThrowError(
      expect.objectContaining<Partial<WorkspacePathError>>({
        code: ERROR_CODES.workspacePathInvalid,
      }),
    );
  });

  it("removes a workspace path during cleanup", async () => {
    const root = await createRoot();
    const manager = new WorkspaceManager({ root });

    const workspace = await manager.createForIssue("ABC-123");
    const removed = await manager.removeForIssue("ABC-123");

    expect(removed).toBe(true);
    await expect(manager.createForIssue("ABC-123")).resolves.toEqual({
      path: workspace.path,
      workspaceKey: "ABC-123",
      createdNow: true,
    });
  });
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "symphony-task6-"));
  roots.push(root);
  return root;
}
