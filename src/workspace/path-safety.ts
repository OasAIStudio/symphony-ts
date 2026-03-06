import { normalize, resolve, sep } from "node:path";

import { toWorkspaceKey } from "../domain/model.js";
import { ERROR_CODES, type ErrorCode } from "../errors/codes.js";

const SAFE_WORKSPACE_KEY_PATTERN = /^[A-Za-z0-9._-]+$/;

export interface WorkspacePathInfo {
  workspaceRoot: string;
  workspacePath: string;
  workspaceKey: string;
}

export class WorkspacePathError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "WorkspacePathError";
    this.code = code;
  }
}

export function sanitizeWorkspaceKey(issueIdentifier: string): string {
  return toWorkspaceKey(issueIdentifier);
}

export function isWorkspaceKeySafe(workspaceKey: string): boolean {
  return (
    workspaceKey.length > 0 && SAFE_WORKSPACE_KEY_PATTERN.test(workspaceKey)
  );
}

export function resolveWorkspaceRoot(workspaceRoot: string): string {
  return normalize(resolve(workspaceRoot));
}

export function resolveWorkspacePath(
  workspaceRoot: string,
  issueIdentifier: string,
): WorkspacePathInfo {
  const normalizedRoot = resolveWorkspaceRoot(workspaceRoot);
  const workspaceKey = sanitizeWorkspaceKey(issueIdentifier);

  assertWorkspaceKeySafe(workspaceKey);

  const workspacePath = normalize(resolve(normalizedRoot, workspaceKey));
  assertWorkspacePathWithinRoot(normalizedRoot, workspacePath);

  return {
    workspaceRoot: normalizedRoot,
    workspacePath,
    workspaceKey,
  };
}

export function assertWorkspaceKeySafe(workspaceKey: string): void {
  if (isWorkspaceKeySafe(workspaceKey)) {
    return;
  }

  throw new WorkspacePathError(
    ERROR_CODES.workspacePathInvalid,
    `Workspace key is invalid: ${workspaceKey || "<empty>"}`,
  );
}

export function assertWorkspacePathWithinRoot(
  workspaceRoot: string,
  workspacePath: string,
): void {
  const normalizedRoot = resolveWorkspaceRoot(workspaceRoot);
  const normalizedPath = normalize(resolve(workspacePath));

  if (
    normalizedPath === normalizedRoot ||
    normalizedPath.startsWith(`${normalizedRoot}${sep}`)
  ) {
    return;
  }

  throw new WorkspacePathError(
    ERROR_CODES.workspaceRootEscape,
    `Workspace path escapes configured root: ${normalizedPath}`,
  );
}

export function validateWorkspaceCwd(input: {
  cwd: string;
  workspacePath: string;
  workspaceRoot: string;
}): string {
  const normalizedWorkspacePath = normalize(resolve(input.workspacePath));
  const normalizedCwd = normalize(resolve(input.cwd));

  assertWorkspacePathWithinRoot(input.workspaceRoot, normalizedWorkspacePath);

  if (normalizedWorkspacePath !== normalizedCwd) {
    throw new WorkspacePathError(
      ERROR_CODES.invalidWorkspaceCwd,
      `Agent cwd must match workspace path: ${normalizedCwd}`,
    );
  }

  return normalizedWorkspacePath;
}
