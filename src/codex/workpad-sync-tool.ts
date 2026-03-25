import { readFile } from "node:fs/promises";

import type { CodexDynamicTool } from "./app-server-client.js";

const WORKPAD_SYNC_DESCRIPTION =
  "Create or update a workpad comment on a Linear issue. Reads body from a local file to keep conversation context small.";

const LINEAR_GRAPHQL_ENDPOINT = "https://api.linear.app/graphql";

type JsonObject = Record<string, unknown>;

export interface WorkpadSyncToolInput {
  issue_id: string;
  file_path: string;
  comment_id?: string;
}

export interface WorkpadSyncToolResult {
  success: boolean;
  comment_id?: string;
  error?: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface WorkpadSyncDynamicToolOptions {
  apiKey: string;
  endpoint?: string;
  networkTimeoutMs?: number;
  fetchFn?: typeof fetch;
}

export const WORKPAD_SYNC_TOOL_NAME = "sync_workpad";

export function createWorkpadSyncDynamicTool(
  options: WorkpadSyncDynamicToolOptions,
): CodexDynamicTool {
  const endpoint = options.endpoint ?? LINEAR_GRAPHQL_ENDPOINT;
  const networkTimeoutMs = options.networkTimeoutMs ?? 30_000;
  const fetchFn = options.fetchFn ?? globalThis.fetch;

  return {
    name: WORKPAD_SYNC_TOOL_NAME,
    description: WORKPAD_SYNC_DESCRIPTION,
    inputSchema: {
      type: "object",
      additionalProperties: false,
      required: ["issue_id", "file_path"],
      properties: {
        issue_id: {
          type: "string",
          minLength: 1,
          description: "The Linear issue ID to attach the workpad comment to.",
        },
        file_path: {
          type: "string",
          minLength: 1,
          description:
            "Local file path to read workpad content from (e.g. workpad.md).",
        },
        comment_id: {
          type: "string",
          description:
            "If provided, update this existing comment. If omitted, create a new comment.",
        },
      },
    },
    async execute(input: unknown): Promise<WorkpadSyncToolResult> {
      const normalized = normalizeInput(input);
      if (!normalized.success) {
        return normalized;
      }

      let body: string;
      try {
        body = await readFile(normalized.file_path, "utf-8");
      } catch (error) {
        return {
          success: false,
          error: {
            code: "file_read_error",
            message:
              error instanceof Error
                ? `Failed to read workpad file: ${error.message}`
                : "Failed to read workpad file.",
          },
        };
      }

      try {
        if (normalized.comment_id !== undefined) {
          const response = await executeGraphql(
            endpoint,
            options.apiKey,
            networkTimeoutMs,
            fetchFn,
            COMMENT_UPDATE_MUTATION,
            { commentId: normalized.comment_id, body },
          );
          const update = response.commentUpdate;
          if (
            update === null ||
            typeof update !== "object" ||
            Array.isArray(update) ||
            (update as Record<string, unknown>).success !== true
          ) {
            return {
              success: false,
              error: {
                code: "linear_response_malformed",
                message: "Linear commentUpdate did not return success.",
                details: response,
              },
            };
          }
          return {
            success: true,
            comment_id: normalized.comment_id,
          };
        }

        const response = await executeGraphql(
          endpoint,
          options.apiKey,
          networkTimeoutMs,
          fetchFn,
          COMMENT_CREATE_MUTATION,
          { issueId: normalized.issue_id, body },
        );

        const commentId = extractCommentId(response);
        if (commentId === null) {
          return {
            success: false,
            error: {
              code: "linear_response_malformed",
              message:
                "Linear commentCreate succeeded but did not return a comment ID.",
              details: response,
            },
          };
        }

        return {
          success: true,
          comment_id: commentId,
        };
      } catch (error) {
        return {
          success: false,
          error: {
            code: "linear_api_request",
            message:
              error instanceof Error
                ? error.message
                : "Linear API request failed.",
          },
        };
      }
    },
  };
}

const COMMENT_CREATE_MUTATION = `
  mutation CommentCreate($issueId: String!, $body: String!) {
    commentCreate(input: { issueId: $issueId, body: $body }) {
      success
      comment {
        id
      }
    }
  }
`;

const COMMENT_UPDATE_MUTATION = `
  mutation CommentUpdate($commentId: String!, $body: String!) {
    commentUpdate(id: $commentId, input: { body: $body }) {
      success
    }
  }
`;

function normalizeInput(input: unknown):
  | (WorkpadSyncToolResult & { success: false })
  | {
      success: true;
      issue_id: string;
      file_path: string;
      comment_id?: string;
    } {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return invalidInput(
      "sync_workpad expects an object with issue_id and file_path.",
    );
  }

  const issueId = "issue_id" in input ? input.issue_id : undefined;
  if (typeof issueId !== "string" || issueId.trim().length === 0) {
    return invalidInput("sync_workpad.issue_id must be a non-empty string.");
  }

  const filePath = "file_path" in input ? input.file_path : undefined;
  if (typeof filePath !== "string" || filePath.trim().length === 0) {
    return invalidInput("sync_workpad.file_path must be a non-empty string.");
  }

  const commentId = "comment_id" in input ? input.comment_id : undefined;
  if (commentId !== undefined && typeof commentId !== "string") {
    return invalidInput(
      "sync_workpad.comment_id must be a string if provided.",
    );
  }

  return {
    success: true,
    issue_id: issueId,
    file_path: filePath,
    ...(commentId === undefined ? {} : { comment_id: commentId }),
  };
}

function invalidInput(
  message: string,
  details?: unknown,
): WorkpadSyncToolResult & { success: false } {
  return {
    success: false,
    error: {
      code: "invalid_input",
      message,
      details: details ?? null,
    },
  };
}

async function executeGraphql(
  endpoint: string,
  apiKey: string,
  networkTimeoutMs: number,
  fetchFn: typeof fetch,
  query: string,
  variables: JsonObject,
): Promise<JsonObject> {
  const response = await fetchFn(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(networkTimeoutMs),
  });

  if (!response.ok) {
    throw new Error(`Linear API returned HTTP ${response.status}.`);
  }

  const body = (await response.json()) as JsonObject;
  const errors = body.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    throw new Error(`Linear GraphQL errors: ${JSON.stringify(errors)}`);
  }

  const data = body.data;
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("Linear API returned unexpected response format.");
  }

  return data as JsonObject;
}

function extractCommentId(data: JsonObject): string | null {
  const commentCreate = data.commentCreate;
  if (
    commentCreate === null ||
    typeof commentCreate !== "object" ||
    Array.isArray(commentCreate)
  ) {
    return null;
  }

  const ccObj = commentCreate as JsonObject;
  if (ccObj.success !== true) {
    return null;
  }

  const comment = ccObj.comment;
  if (
    comment === null ||
    typeof comment !== "object" ||
    Array.isArray(comment)
  ) {
    return null;
  }

  const id = (comment as JsonObject).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}
