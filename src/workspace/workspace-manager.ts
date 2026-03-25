import { promises as fs } from "node:fs";

import type { Workspace } from "../domain/model.js";
import { ERROR_CODES } from "../errors/codes.js";
import type { WorkspaceHookRunner } from "./hooks.js";
import {
  WorkspacePathError,
  type WorkspacePathInfo,
  resolveWorkspacePath,
} from "./path-safety.js";

interface FileSystemLike {
  lstat(path: string): Promise<{ isDirectory(): boolean }>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<unknown>;
  rm(
    path: string,
    options?: { force?: boolean; recursive?: boolean },
  ): Promise<void>;
}

export interface WorkspaceManagerOptions {
  root: string;
  fs?: FileSystemLike;
  hooks?: WorkspaceHookRunner | null;
}

/**
 * A simple async mutual-exclusion lock.
 *
 * Callers acquire the lock with `acquire()`, which returns a `release`
 * function. The next waiter is unblocked only after `release()` is called.
 * `depth` reflects the total number of callers currently holding or queued
 * for the lock, which can be inspected *before* calling `acquire()` to
 * determine whether the caller will have to wait.
 */
export class AsyncMutex {
  #queue: Promise<void> = Promise.resolve();
  #depth = 0;

  /** Total number of callers holding or waiting for the lock. */
  get depth(): number {
    return this.#depth;
  }

  /**
   * Acquire the lock. Resolves with a `release` function that must be called
   * to hand the lock to the next waiter.
   */
  acquire(): Promise<() => void> {
    this.#depth++;

    let unlock!: () => void;
    const prev = this.#queue;
    this.#queue = this.#queue.then(
      () =>
        new Promise<void>((resolve) => {
          unlock = resolve;
        }),
    );

    return prev.then(() => {
      const release = () => {
        this.#depth--;
        unlock();
      };
      return release;
    });
  }
}

/**
 * Module-level registry of per-root creation mutexes.
 *
 * Keyed by `workspaceRoot` (the normalised bare-clone path) so that
 * concurrent creations for the same repo are serialised while creations
 * for different repos can proceed independently.
 */
const creationMutexes = new Map<string, AsyncMutex>();

function getCreationMutex(workspaceRoot: string): AsyncMutex {
  let mutex = creationMutexes.get(workspaceRoot);
  if (!mutex) {
    mutex = new AsyncMutex();
    creationMutexes.set(workspaceRoot, mutex);
  }
  return mutex;
}

export class WorkspaceManager {
  readonly root: string;
  readonly #fs: FileSystemLike;
  readonly #hooks: WorkspaceHookRunner | null;

  constructor(options: WorkspaceManagerOptions) {
    this.root = options.root;
    this.#fs = options.fs ?? fs;
    this.#hooks = isHookRunner(options.hooks) ? options.hooks : null;
  }

  resolveForIssue(issueId: string): WorkspacePathInfo {
    return resolveWorkspacePath(this.root, issueId);
  }

  async createForIssue(issueId: string): Promise<Workspace> {
    const { workspaceKey, workspacePath, workspaceRoot } =
      this.resolveForIssue(issueId);

    try {
      await this.#fs.mkdir(workspaceRoot, { recursive: true });
      const createdNow = await this.#ensureWorkspaceDirectory(workspacePath);
      const workspace = {
        path: workspacePath,
        workspaceKey,
        createdNow,
      };

      if (createdNow) {
        const mutex = getCreationMutex(workspaceRoot);
        const queueDepth = mutex.depth;

        if (queueDepth > 0) {
          console.log(
            `[workspace] afterCreate for ${workspacePath} is queued (depth: ${queueDepth})`,
          );
        } else {
          console.log(
            `[workspace] afterCreate for ${workspacePath} is executing`,
          );
        }

        const release = await mutex.acquire();
        try {
          await this.#hooks?.run({
            name: "afterCreate",
            workspacePath,
          });
        } finally {
          release();
        }
      }

      return workspace;
    } catch (error) {
      if (error instanceof WorkspacePathError) {
        throw error;
      }

      throw new WorkspacePathError(
        ERROR_CODES.workspaceCreateFailed,
        `Failed to prepare workspace for ${issueId}`,
        { cause: error },
      );
    }
  }

  async removeForIssue(issueId: string): Promise<boolean> {
    const { workspacePath } = this.resolveForIssue(issueId);

    try {
      const existsAsDirectory = await this.#workspaceExists(workspacePath);
      if (existsAsDirectory) {
        await this.#hooks?.runBestEffort({
          name: "beforeRemove",
          workspacePath,
        });
      }

      await this.#fs.rm(workspacePath, { force: true, recursive: true });
      return true;
    } catch (error) {
      throw new WorkspacePathError(
        ERROR_CODES.workspaceCleanupFailed,
        `Failed to remove workspace for ${issueId}`,
        { cause: error },
      );
    }
  }

  async #ensureWorkspaceDirectory(workspacePath: string): Promise<boolean> {
    try {
      const current = await this.#fs.lstat(workspacePath);

      if (current.isDirectory()) {
        return false;
      }

      throw new WorkspacePathError(
        ERROR_CODES.workspacePathInvalid,
        `Workspace path exists and is not a directory: ${workspacePath}`,
      );
    } catch (error) {
      if (!isMissingPathError(error)) {
        throw error;
      }
    }

    try {
      await this.#fs.mkdir(workspacePath);
      return true;
    } catch (error) {
      if (isAlreadyExistsError(error)) {
        const current = await this.#fs.lstat(workspacePath);

        if (current.isDirectory()) {
          return false;
        }

        throw new WorkspacePathError(
          ERROR_CODES.workspacePathInvalid,
          `Workspace path exists and is not a directory: ${workspacePath}`,
        );
      }

      throw error;
    }
  }

  async #workspaceExists(workspacePath: string): Promise<boolean> {
    try {
      const current = await this.#fs.lstat(workspacePath);
      return current.isDirectory();
    } catch (error) {
      if (isMissingPathError(error)) {
        return false;
      }

      throw error;
    }
  }
}

function isHookRunner(
  value: WorkspaceManagerOptions["hooks"],
): value is WorkspaceHookRunner {
  return (
    typeof value === "object" &&
    value !== null &&
    "run" in value &&
    typeof value.run === "function" &&
    "runBestEffort" in value &&
    typeof value.runBestEffort === "function"
  );
}

function isMissingPathError(
  error: unknown,
): error is NodeJS.ErrnoException & { code: "ENOENT" } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "ENOENT"
  );
}

function isAlreadyExistsError(
  error: unknown,
): error is NodeJS.ErrnoException & { code: "EEXIST" } {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "EEXIST"
  );
}
