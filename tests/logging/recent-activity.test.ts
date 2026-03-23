import { describe, expect, it } from "vitest";

import type { CodexClientEvent } from "../../src/codex/app-server-client.js";
import { createEmptyLiveSession } from "../../src/domain/model.js";
import {
  applyCodexEventToSession,
  buildActivityContext,
  extractToolInputFromRaw,
  extractToolNameFromRaw,
} from "../../src/logging/session-metrics.js";

function createEvent(
  event: CodexClientEvent["event"],
  overrides?: Partial<CodexClientEvent>,
): CodexClientEvent {
  return {
    event,
    timestamp: "2026-03-21T10:00:01.000Z",
    codexAppServerPid: "42",
    ...overrides,
  };
}

describe("extractToolNameFromRaw", () => {
  it("extracts tool name from params.toolName", () => {
    expect(extractToolNameFromRaw({ params: { toolName: "Read" } })).toBe(
      "Read",
    );
  });

  it("extracts tool name from params.name", () => {
    expect(extractToolNameFromRaw({ params: { name: "Edit" } })).toBe("Edit");
  });

  it("extracts tool name from params.tool.name", () => {
    expect(
      extractToolNameFromRaw({ params: { tool: { name: "Write" } } }),
    ).toBe("Write");
  });

  it("extracts tool name from top-level name", () => {
    expect(extractToolNameFromRaw({ name: "Bash" })).toBe("Bash");
  });

  it("returns null when no tool name is found", () => {
    expect(extractToolNameFromRaw({ params: {} })).toBeNull();
  });
});

describe("extractToolInputFromRaw", () => {
  it("extracts from params.input", () => {
    const result = extractToolInputFromRaw({
      params: { input: { file_path: "/src/foo.ts" } },
    });
    expect(result).toEqual({ file_path: "/src/foo.ts" });
  });

  it("extracts from params.arguments", () => {
    const result = extractToolInputFromRaw({
      params: { arguments: { command: "ls -la" } },
    });
    expect(result).toEqual({ command: "ls -la" });
  });

  it("returns undefined when params is missing", () => {
    expect(extractToolInputFromRaw({})).toBeUndefined();
  });
});

describe("buildActivityContext", () => {
  it("extracts basename for Read tool", () => {
    expect(
      buildActivityContext("Read", { file_path: "/home/user/src/model.ts" }),
    ).toBe("model.ts");
  });

  it("extracts basename for Edit tool", () => {
    expect(
      buildActivityContext("Edit", { file_path: "/repo/src/index.ts" }),
    ).toBe("index.ts");
  });

  it("extracts basename for Write tool", () => {
    expect(
      buildActivityContext("Write", { file_path: "/tmp/output.json" }),
    ).toBe("output.json");
  });

  it("extracts pattern for Glob tool", () => {
    expect(buildActivityContext("Glob", { pattern: "**/*.ts" })).toBe(
      "**/*.ts",
    );
  });

  it("extracts pattern for Grep tool", () => {
    expect(buildActivityContext("Grep", { pattern: "extractToolName" })).toBe(
      "extractToolName",
    );
  });

  it("truncates long Bash commands to ~60 chars", () => {
    const longCommand =
      "find /home/user -name '*.ts' -exec grep -l 'import' {} \\; | sort | uniq | head -100";
    const result = buildActivityContext("Bash", { command: longCommand });
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(61); // 60 + ellipsis char
    expect(result!).toContain("…");
  });

  it("keeps short Bash commands as-is", () => {
    expect(buildActivityContext("Bash", { command: "npm test" })).toBe(
      "npm test",
    );
  });

  it("returns null for unknown tools", () => {
    expect(buildActivityContext("UnknownTool", { some: "data" })).toBeNull();
  });

  it("returns null when input is not an object", () => {
    expect(buildActivityContext("Read", null)).toBeNull();
    expect(buildActivityContext("Read", undefined)).toBeNull();
    expect(buildActivityContext("Read", "string")).toBeNull();
  });
});

describe("recent activity ring buffer", () => {
  it("populates recentActivity on approval_auto_approved events", () => {
    const session = createEmptyLiveSession();

    const event = createEvent("approval_auto_approved", {
      raw: {
        params: {
          toolName: "Read",
          input: { file_path: "/repo/src/model.ts" },
        },
      },
    });

    applyCodexEventToSession(session, event);

    expect(session.recentActivity).toHaveLength(1);
    expect(session.recentActivity[0]).toEqual({
      timestamp: "2026-03-21T10:00:01.000Z",
      toolName: "Read",
      context: "model.ts",
    });
  });

  it("does not populate recentActivity on non-approval events", () => {
    const session = createEmptyLiveSession();

    const event = createEvent("notification", {
      raw: {
        params: {
          toolName: "Read",
          input: { file_path: "/repo/src/model.ts" },
        },
      },
    });

    applyCodexEventToSession(session, event);

    expect(session.recentActivity).toHaveLength(0);
  });

  it("trims ring buffer to max 10 entries", () => {
    const session = createEmptyLiveSession();

    for (let i = 0; i < 15; i++) {
      const event = createEvent("approval_auto_approved", {
        timestamp: `2026-03-21T10:00:${String(i).padStart(2, "0")}.000Z`,
        raw: {
          params: {
            toolName: "Edit",
            input: { file_path: `/repo/src/file-${i}.ts` },
          },
        },
      });
      applyCodexEventToSession(session, event);
    }

    expect(session.recentActivity).toHaveLength(10);
    // The first 5 should have been trimmed; the oldest remaining entry is file-5
    expect(session.recentActivity[0]!.context).toBe("file-5.ts");
    expect(session.recentActivity[9]!.context).toBe("file-14.ts");
  });

  it("records Bash tool calls with truncated commands", () => {
    const session = createEmptyLiveSession();

    const event = createEvent("approval_auto_approved", {
      raw: {
        params: {
          toolName: "Bash",
          input: { command: "npm test" },
        },
      },
    });

    applyCodexEventToSession(session, event);

    expect(session.recentActivity).toHaveLength(1);
    expect(session.recentActivity[0]!.toolName).toBe("Bash");
    expect(session.recentActivity[0]!.context).toBe("npm test");
  });

  it("records unknown tool calls with null context", () => {
    const session = createEmptyLiveSession();

    const event = createEvent("approval_auto_approved", {
      raw: {
        params: {
          toolName: "CustomTool",
          input: { data: "value" },
        },
      },
    });

    applyCodexEventToSession(session, event);

    expect(session.recentActivity).toHaveLength(1);
    expect(session.recentActivity[0]!.toolName).toBe("CustomTool");
    expect(session.recentActivity[0]!.context).toBeNull();
  });

  it("skips when raw is null or missing", () => {
    const session = createEmptyLiveSession();

    applyCodexEventToSession(
      session,
      createEvent("approval_auto_approved", { raw: undefined }),
    );
    applyCodexEventToSession(
      session,
      createEvent("approval_auto_approved", {
        raw: null as unknown as undefined,
      }),
    );

    expect(session.recentActivity).toHaveLength(0);
  });

  it("skips when tool name cannot be extracted", () => {
    const session = createEmptyLiveSession();

    applyCodexEventToSession(
      session,
      createEvent("approval_auto_approved", {
        raw: { params: { somethingElse: true } },
      }),
    );

    expect(session.recentActivity).toHaveLength(0);
  });
});
