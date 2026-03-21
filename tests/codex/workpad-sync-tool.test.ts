import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createWorkpadSyncDynamicTool } from "../../src/index.js";

describe("createWorkpadSyncDynamicTool", () => {
  let tempDir: string;
  let workpadPath: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "workpad-sync-test-"));
    workpadPath = join(tempDir, "workpad.md");
    await writeFile(workpadPath, "# Workpad\n\n## Status\nIn progress.");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  it("creates a new comment and returns the comment_id", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          commentCreate: {
            success: true,
            comment: { id: "comment-abc-123" },
          },
        },
      }),
    );
    const tool = createWorkpadSyncDynamicTool({
      apiKey: "linear-token",
      fetchFn,
    });

    const result = await tool.execute({
      issue_id: "issue-1",
      file_path: workpadPath,
    });

    expect(result).toEqual({
      success: true,
      comment_id: "comment-abc-123",
    });

    expect(fetchFn).toHaveBeenCalledOnce();
    const [url, init] = fetchFn.mock.calls[0]!;
    expect(url).toBe("https://api.linear.app/graphql");
    expect(init?.method).toBe("POST");
    const body = JSON.parse(init?.body as string);
    expect(body.variables.issueId).toBe("issue-1");
    expect(body.variables.body).toBe("# Workpad\n\n## Status\nIn progress.");
    expect(body.query).toContain("commentCreate");
  });

  it("updates an existing comment when comment_id is provided", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          commentUpdate: {
            success: true,
          },
        },
      }),
    );
    const tool = createWorkpadSyncDynamicTool({
      apiKey: "linear-token",
      fetchFn,
    });

    const result = await tool.execute({
      issue_id: "issue-1",
      file_path: workpadPath,
      comment_id: "comment-existing-456",
    });

    expect(result).toEqual({
      success: true,
      comment_id: "comment-existing-456",
    });

    expect(fetchFn).toHaveBeenCalledOnce();
    const body = JSON.parse(fetchFn.mock.calls[0]![1]?.body as string);
    expect(body.variables.commentId).toBe("comment-existing-456");
    expect(body.query).toContain("commentUpdate");
  });

  it("returns file_read_error when file does not exist", async () => {
    const tool = createWorkpadSyncDynamicTool({
      apiKey: "linear-token",
      fetchFn: vi.fn<typeof fetch>(),
    });

    const result = await tool.execute({
      issue_id: "issue-1",
      file_path: "/nonexistent/workpad.md",
    });

    expect(result).toMatchObject({
      success: false,
      error: {
        code: "file_read_error",
      },
    });
  });

  it("rejects missing issue_id", async () => {
    const tool = createWorkpadSyncDynamicTool({
      apiKey: "linear-token",
      fetchFn: vi.fn<typeof fetch>(),
    });

    const result = await tool.execute({
      file_path: workpadPath,
    });

    expect(result).toMatchObject({
      success: false,
      error: {
        code: "invalid_input",
        message: "sync_workpad.issue_id must be a non-empty string.",
      },
    });
  });

  it("rejects missing file_path", async () => {
    const tool = createWorkpadSyncDynamicTool({
      apiKey: "linear-token",
      fetchFn: vi.fn<typeof fetch>(),
    });

    const result = await tool.execute({
      issue_id: "issue-1",
    });

    expect(result).toMatchObject({
      success: false,
      error: {
        code: "invalid_input",
        message: "sync_workpad.file_path must be a non-empty string.",
      },
    });
  });

  it("rejects non-object input", async () => {
    const tool = createWorkpadSyncDynamicTool({
      apiKey: "linear-token",
      fetchFn: vi.fn<typeof fetch>(),
    });

    const result = await tool.execute("just a string");

    expect(result).toMatchObject({
      success: false,
      error: {
        code: "invalid_input",
        message: "sync_workpad expects an object with issue_id and file_path.",
      },
    });
  });

  it("rejects non-string comment_id", async () => {
    const tool = createWorkpadSyncDynamicTool({
      apiKey: "linear-token",
      fetchFn: vi.fn<typeof fetch>(),
    });

    const result = await tool.execute({
      issue_id: "issue-1",
      file_path: workpadPath,
      comment_id: 123,
    });

    expect(result).toMatchObject({
      success: false,
      error: {
        code: "invalid_input",
        message: "sync_workpad.comment_id must be a string if provided.",
      },
    });
  });

  it("returns error when Linear API returns HTTP error", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response("Internal Server Error", { status: 500 }),
      );
    const tool = createWorkpadSyncDynamicTool({
      apiKey: "linear-token",
      fetchFn,
    });

    const result = await tool.execute({
      issue_id: "issue-1",
      file_path: workpadPath,
    });

    expect(result).toMatchObject({
      success: false,
      error: {
        code: "linear_api_request",
        message: "Linear API returned HTTP 500.",
      },
    });
  });

  it("returns error when Linear API returns GraphQL errors", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: null,
        errors: [{ message: "forbidden" }],
      }),
    );
    const tool = createWorkpadSyncDynamicTool({
      apiKey: "linear-token",
      fetchFn,
    });

    const result = await tool.execute({
      issue_id: "issue-1",
      file_path: workpadPath,
    });

    expect(result).toMatchObject({
      success: false,
      error: {
        code: "linear_api_request",
      },
    });
  });

  it("returns error when commentCreate returns no comment id", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          commentCreate: {
            success: false,
          },
        },
      }),
    );
    const tool = createWorkpadSyncDynamicTool({
      apiKey: "linear-token",
      fetchFn,
    });

    const result = await tool.execute({
      issue_id: "issue-1",
      file_path: workpadPath,
    });

    expect(result).toMatchObject({
      success: false,
      error: {
        code: "linear_response_malformed",
      },
    });
  });

  it("returns error when fetch itself throws (network failure)", async () => {
    const fetchFn = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("network down"));
    const tool = createWorkpadSyncDynamicTool({
      apiKey: "linear-token",
      fetchFn,
    });

    const result = await tool.execute({
      issue_id: "issue-1",
      file_path: workpadPath,
    });

    expect(result).toMatchObject({
      success: false,
      error: {
        code: "linear_api_request",
        message: "network down",
      },
    });
  });

  it("uses custom endpoint when provided", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          commentCreate: {
            success: true,
            comment: { id: "comment-999" },
          },
        },
      }),
    );
    const tool = createWorkpadSyncDynamicTool({
      apiKey: "linear-token",
      endpoint: "https://custom.linear.dev/graphql",
      fetchFn,
    });

    await tool.execute({
      issue_id: "issue-1",
      file_path: workpadPath,
    });

    expect(fetchFn.mock.calls[0]![0]).toBe("https://custom.linear.dev/graphql");
  });

  it("returns error when commentCreate has no comment field", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          commentCreate: {
            success: true,
            // no comment field
          },
        },
      }),
    );
    const tool = createWorkpadSyncDynamicTool({
      apiKey: "linear-token",
      fetchFn,
    });
    const result = await tool.execute({
      issue_id: "issue-1",
      file_path: workpadPath,
    });
    expect(result).toMatchObject({
      success: false,
      error: { code: "linear_response_malformed" },
    });
  });

  it("returns error when commentCreate returns empty comment id", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          commentCreate: {
            success: true,
            comment: { id: "" },
          },
        },
      }),
    );
    const tool = createWorkpadSyncDynamicTool({
      apiKey: "linear-token",
      fetchFn,
    });
    const result = await tool.execute({
      issue_id: "issue-1",
      file_path: workpadPath,
    });
    expect(result).toMatchObject({
      success: false,
      error: { code: "linear_response_malformed" },
    });
  });

  it("returns error when commentUpdate returns success false", async () => {
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          commentUpdate: {
            success: false,
          },
        },
      }),
    );
    const tool = createWorkpadSyncDynamicTool({
      apiKey: "linear-token",
      fetchFn,
    });
    const result = await tool.execute({
      issue_id: "issue-1",
      file_path: workpadPath,
      comment_id: "existing-comment-id",
    });
    expect(result).toMatchObject({
      success: false,
      error: { code: "linear_response_malformed" },
    });
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}
