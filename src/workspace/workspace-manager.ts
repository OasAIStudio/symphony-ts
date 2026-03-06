import { promises as fs } from "node:fs";

import type { Workspace } from "../domain/model.js";
import { ERROR_CODES } from "../errors/codes.js";
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
}

export class WorkspaceManager {
  readonly root: string;
  readonly #fs: FileSystemLike;

  constructor(options: WorkspaceManagerOptions) {
    this.root = options.root;
    this.#fs = options.fs ?? fs;
  }

  resolveForIssue(issueIdentifier: string): WorkspacePathInfo {
    return resolveWorkspacePath(this.root, issueIdentifier);
  }

  async createForIssue(issueIdentifier: string): Promise<Workspace> {
    const { workspaceKey, workspacePath, workspaceRoot } =
      this.resolveForIssue(issueIdentifier);

    try {
      await this.#fs.mkdir(workspaceRoot, { recursive: true });
      const createdNow = await this.#ensureWorkspaceDirectory(workspacePath);

      return {
        path: workspacePath,
        workspaceKey,
        createdNow,
      };
    } catch (error) {
      if (error instanceof WorkspacePathError) {
        throw error;
      }

      throw new WorkspacePathError(
        ERROR_CODES.workspaceCreateFailed,
        `Failed to prepare workspace for ${issueIdentifier}`,
        { cause: error },
      );
    }
  }

  async removeForIssue(issueIdentifier: string): Promise<boolean> {
    const { workspacePath } = this.resolveForIssue(issueIdentifier);

    try {
      await this.#fs.rm(workspacePath, { force: true, recursive: true });
      return true;
    } catch (error) {
      throw new WorkspacePathError(
        ERROR_CODES.workspaceCleanupFailed,
        `Failed to remove workspace for ${issueIdentifier}`,
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
