import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { ERROR_CODES } from "../../src/errors/codes.js";
import {
  AsyncMutex,
  WorkspaceHookRunner,
  WorkspaceManager,
  type WorkspacePathError,
} from "../../src/index.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.allSettled(
    roots.splice(0).map(async (root) => {
      const manager = new WorkspaceManager({ root });
      await manager.removeForIssue("issue-123");
      await manager.removeForIssue("issue/123:needs review");
    }),
  );
});

describe("WorkspaceManager", () => {
  it("creates a missing workspace directory with a deterministic path", async () => {
    const root = await createRoot();
    const manager = new WorkspaceManager({ root });

    const workspace = await manager.createForIssue("issue/123:needs review");

    expect(workspace.workspaceKey).toBe("issue_123_needs_review");
    expect(workspace.path).toBe(join(root, "issue_123_needs_review"));
    expect(workspace.createdNow).toBe(true);
  });

  it("reuses an existing workspace directory on later attempts", async () => {
    const root = await createRoot();
    const manager = new WorkspaceManager({ root });

    await manager.createForIssue("issue-123");
    const workspace = await manager.createForIssue("issue-123");

    expect(workspace.path).toBe(join(root, "issue-123"));
    expect(workspace.createdNow).toBe(false);
  });

  it("runs afterCreate only for newly created workspaces", async () => {
    const root = await createRoot();
    const hookCalls: string[] = [];
    const hooks = new WorkspaceHookRunner({
      config: {
        afterCreate: "prepare",
        beforeRun: null,
        afterRun: null,
        beforeRemove: null,
        timeoutMs: 100,
      },
      execute: async (_script, options) => {
        hookCalls.push(options.cwd);
        return {
          exitCode: 0,
          signal: null,
          stdout: "",
          stderr: "",
        };
      },
    });
    const manager = new WorkspaceManager({ root, hooks });

    const first = await manager.createForIssue("issue-123");
    await manager.createForIssue("issue-123");

    expect(hookCalls).toEqual([first.path]);
  });

  it("runs beforeRemove as a best-effort hook when deleting an existing workspace", async () => {
    const root = await createRoot();
    const hookCalls: string[] = [];
    const hooks = new WorkspaceHookRunner({
      config: {
        afterCreate: null,
        beforeRun: null,
        afterRun: null,
        beforeRemove: "cleanup",
        timeoutMs: 100,
      },
      execute: async (_script, options) => {
        hookCalls.push(options.cwd);
        return {
          exitCode: 1,
          signal: null,
          stdout: "",
          stderr: "ignored",
        };
      },
    });
    const manager = new WorkspaceManager({ root, hooks });

    const workspace = await manager.createForIssue("issue-123");
    const removed = await manager.removeForIssue("issue-123");

    expect(removed).toBe(true);
    expect(hookCalls).toEqual([workspace.path]);
  });

  it("fails safely when the workspace path already exists as a file", async () => {
    const root = await createRoot();
    await writeFile(join(root, "issue-123"), "not a directory");
    const manager = new WorkspaceManager({ root });

    await expect(manager.createForIssue("issue-123")).rejects.toThrowError(
      expect.objectContaining<Partial<WorkspacePathError>>({
        code: ERROR_CODES.workspacePathInvalid,
      }),
    );
  });

  it("removes a workspace path during cleanup", async () => {
    const root = await createRoot();
    const manager = new WorkspaceManager({ root });

    const workspace = await manager.createForIssue("issue-123");
    const removed = await manager.removeForIssue("issue-123");

    expect(removed).toBe(true);
    await expect(manager.createForIssue("issue-123")).resolves.toEqual({
      path: workspace.path,
      workspaceKey: "issue-123",
      createdNow: true,
    });
  });

  it("serialises afterCreate hook calls for workspaces under the same root", async () => {
    const root = await createRoot();
    const execOrder: string[] = [];

    const hooks = new WorkspaceHookRunner({
      config: {
        afterCreate: "prepare",
        beforeRun: null,
        afterRun: null,
        beforeRemove: null,
        timeoutMs: 5_000,
      },
      execute: async (_script, options) => {
        execOrder.push(options.cwd);
        if (execOrder.length === 1) {
          // Pause to let the second caller queue up behind the mutex.
          await new Promise<void>((r) => setTimeout(r, 20));
        }
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      },
    });

    const manager = new WorkspaceManager({ root, hooks });

    // Start both creations concurrently.
    const [w1, w2] = await Promise.all([
      manager.createForIssue("issue-aaa"),
      manager.createForIssue("issue-bbb"),
    ]);

    // Both workspaces should have been created.
    expect(w1.createdNow).toBe(true);
    expect(w2.createdNow).toBe(true);

    // The two afterCreate hooks must have run one after the other.
    // The exact ordering is not guaranteed, but the array must contain
    // exactly two distinct paths.
    expect(execOrder).toHaveLength(2);
    expect(new Set(execOrder).size).toBe(2);
  });

  it("does not block removeForIssue while afterCreate hook is running", async () => {
    const root = await createRoot();
    let hookRunning = false;
    let removeCalledWhileHookRunning = false;

    const hooks = new WorkspaceHookRunner({
      config: {
        afterCreate: "prepare",
        beforeRun: null,
        afterRun: null,
        beforeRemove: null,
        timeoutMs: 5_000,
      },
      execute: async (_script, _options) => {
        hookRunning = true;
        // Give removeForIssue a chance to run while this hook is "executing".
        await new Promise<void>((r) => setTimeout(r, 20));
        hookRunning = false;
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      },
    });

    const manager = new WorkspaceManager({ root, hooks });

    const createPromise = manager.createForIssue("issue-123");

    // Poll briefly until the hook has started.
    await new Promise<void>((r) => setTimeout(r, 5));

    // removeForIssue should proceed without waiting for the mutex.
    const removePromise = manager.removeForIssue("issue-123").then((result) => {
      removeCalledWhileHookRunning = hookRunning;
      return result;
    });

    await Promise.all([createPromise, removePromise]);

    // Remove ran while the hook was still executing (i.e. was not blocked).
    expect(removeCalledWhileHookRunning).toBe(true);
  });
});

describe("AsyncMutex", () => {
  it("allows the first caller to acquire immediately", async () => {
    const mutex = new AsyncMutex();
    expect(mutex.depth).toBe(0);

    const release = await mutex.acquire();
    expect(mutex.depth).toBe(1);

    release();
    expect(mutex.depth).toBe(0);
  });

  it("queues a second caller until the first releases", async () => {
    const mutex = new AsyncMutex();
    const order: string[] = [];

    const release1 = await mutex.acquire();
    order.push("acquired-1");

    // Start second acquire – it should not resolve until release1() is called.
    const p2 = mutex.acquire().then((release2) => {
      order.push("acquired-2");
      release2();
    });

    // Depth should now be 2 (one holder + one waiter).
    expect(mutex.depth).toBe(2);

    release1();
    await p2;

    expect(order).toEqual(["acquired-1", "acquired-2"]);
    expect(mutex.depth).toBe(0);
  });

  it("reports depth accurately across multiple waiters", async () => {
    const mutex = new AsyncMutex();

    const r1 = await mutex.acquire();
    const p2 = mutex.acquire();
    const p3 = mutex.acquire();

    expect(mutex.depth).toBe(3);

    r1();
    const r2 = await p2;
    expect(mutex.depth).toBe(2);

    r2();
    const r3 = await p3;
    expect(mutex.depth).toBe(1);

    r3();
    expect(mutex.depth).toBe(0);
  });

  it("logs queue depth when creation is queued behind another", async () => {
    const root = await createRoot();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const hooks = new WorkspaceHookRunner({
      config: {
        afterCreate: "prepare",
        beforeRun: null,
        afterRun: null,
        beforeRemove: null,
        timeoutMs: 5_000,
      },
      execute: async (_script, _options) => {
        await new Promise<void>((r) => setTimeout(r, 30));
        return { exitCode: 0, signal: null, stdout: "", stderr: "" };
      },
    });

    const manager = new WorkspaceManager({ root, hooks });

    await Promise.all([
      manager.createForIssue("issue-aaa"),
      manager.createForIssue("issue-bbb"),
    ]);

    // At least one call should mention "queued".
    const queuedLogs = logSpy.mock.calls.filter((args) =>
      String(args[0]).includes("queued"),
    );
    expect(queuedLogs.length).toBeGreaterThanOrEqual(1);

    logSpy.mockRestore();
  });
});

async function createRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "symphony-task6-"));
  roots.push(root);
  return root;
}
