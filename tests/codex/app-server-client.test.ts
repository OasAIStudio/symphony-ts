import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CodexAppServerClient,
  type CodexAppServerClientError,
  type CodexClientEvent,
} from "../../src/codex/app-server-client.js";
import { createLinearGraphqlDynamicTool } from "../../src/codex/linear-graphql-tool.js";
import { ERROR_CODES } from "../../src/errors/codes.js";

const roots: string[] = [];
const fixturePath = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/codex-fake-server.mjs",
);

afterEach(async () => {
  await Promise.allSettled(
    roots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("CodexAppServerClient", () => {
  it("launches the app-server, buffers partial stdout lines, and auto-resolves approvals/tool calls", async () => {
    const workspace = await createWorkspace();
    const events: CodexClientEvent[] = [];
    const client = createClient("happy", workspace, events);

    const result = await client.startSession({
      prompt: "Implement the ticket",
      title: "ABC-123: Example",
    });

    expect(result).toMatchObject({
      status: "completed",
      threadId: "thread-1",
      turnId: "turn-1",
      sessionId: "thread-1-turn-1",
      usage: {
        inputTokens: 14,
        outputTokens: 9,
        totalTokens: 23,
      },
      rateLimits: {
        requestsRemaining: 10,
        tokensRemaining: 1000,
      },
      message: "First turn finished",
    });

    expect(events.map((event) => event.event)).toContain("session_started");
    expect(events.map((event) => event.event)).toContain(
      "approval_auto_approved",
    );
    expect(events.map((event) => event.event)).toContain(
      "unsupported_tool_call",
    );
    expect(events.map((event) => event.event)).toContain("turn_completed");
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "other_message",
        message: "diagnostic from stderr",
      } satisfies Partial<CodexClientEvent>),
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        event: "notification",
        usage: {
          inputTokens: 11,
          outputTokens: 7,
          totalTokens: 18,
        },
      } satisfies Partial<CodexClientEvent>),
    );

    await client.close();
  });

  it("reuses the same thread id across continuation turns", async () => {
    const workspace = await createWorkspace();
    const events: CodexClientEvent[] = [];
    const client = createClient("happy", workspace, events);

    const first = await client.startSession({
      prompt: "First prompt",
      title: "ABC-123: Example",
    });
    const second = await client.continueTurn(
      "Continue the same issue",
      "ABC-123: Example",
    );

    expect(first.threadId).toBe("thread-1");
    expect(second.threadId).toBe("thread-1");
    expect(second.turnId).toBe("turn-2");
    expect(second.sessionId).toBe("thread-1-turn-2");

    const started = events.filter((event) => event.event === "session_started");
    expect(started).toHaveLength(2);
    expect(started[0]?.threadId).toBe("thread-1");
    expect(started[1]?.threadId).toBe("thread-1");
    expect(started[1]?.turnId).toBe("turn-2");

    await client.close();
  });

  it("fails the turn when the app-server asks for user input", async () => {
    const workspace = await createWorkspace();
    const events: CodexClientEvent[] = [];
    const client = createClient("user-input", workspace, events);

    await expect(
      client.startSession({
        prompt: "Need help?",
        title: "ABC-123: Example",
      }),
    ).rejects.toMatchObject({
      name: "CodexAppServerClientError",
      code: ERROR_CODES.codexUserInputRequired,
    } satisfies Partial<CodexAppServerClientError>);

    expect(events).toContainEqual(
      expect.objectContaining({
        event: "turn_input_required",
        errorCode: ERROR_CODES.codexUserInputRequired,
      }),
    );

    await client.close();
  });

  it("accepts compatible approval and telemetry payload variants", async () => {
    const workspace = await createWorkspace();
    const events: CodexClientEvent[] = [];
    const client = createClient("payload-variants", workspace, events);

    const first = await client.startSession({
      prompt: "Use alternate payloads",
      title: "ABC-123: Example",
    });
    const second = await client.continueTurn(
      "Continue with alternate payloads",
      "ABC-123: Example",
    );

    expect(first.status).toBe("completed");
    expect(second).toMatchObject({
      status: "completed",
      usage: {
        inputTokens: 20,
        outputTokens: 10,
        totalTokens: 30,
      },
      rateLimits: {
        requests_remaining: 9,
        tokens_remaining: 999,
      },
    });
    expect(events.map((event) => event.event)).toContain(
      "approval_auto_approved",
    );

    await client.close();
  });

  it("fails the turn when user-input-required is emitted through a compatible variant", async () => {
    const workspace = await createWorkspace();
    const events: CodexClientEvent[] = [];
    const client = createClient("user-input-variant", workspace, events);

    await expect(
      client.startSession({
        prompt: "Need help?",
        title: "ABC-123: Example",
      }),
    ).rejects.toMatchObject({
      name: "CodexAppServerClientError",
      code: ERROR_CODES.codexUserInputRequired,
    } satisfies Partial<CodexAppServerClientError>);

    expect(events).toContainEqual(
      expect.objectContaining({
        event: "turn_input_required",
        errorCode: ERROR_CODES.codexUserInputRequired,
      }),
    );

    await client.close();
  });

  it("sends the required initialize, thread/start, and turn/start policy payloads", async () => {
    const workspace = await createWorkspace();
    const client = createClient("handshake", workspace, []);

    const result = await client.startSession({
      prompt: "Inspect startup payloads",
      title: "ABC-123: Example",
    });

    expect(result.status).toBe("completed");

    await client.close();
  });

  it("advertises and executes the linear_graphql dynamic tool", async () => {
    const workspace = await createWorkspace();
    const events: CodexClientEvent[] = [];
    const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(
      jsonResponse({
        data: {
          viewer: {
            id: "viewer-1",
            name: "Example User",
          },
        },
      }),
    );
    const client = createClient("linear-tool", workspace, events, {
      dynamicTools: [
        createLinearGraphqlDynamicTool({
          endpoint: "https://api.linear.app/graphql",
          apiKey: "linear-token",
          fetchFn,
        }),
      ],
    });

    const result = await client.startSession({
      prompt: "Use the tracker tool",
      title: "ABC-123: Example",
    });

    expect(result.status).toBe("completed");
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(events.map((event) => event.event)).not.toContain(
      "unsupported_tool_call",
    );

    await client.close();
  });

  it("enforces read timeouts during the startup handshake", async () => {
    const workspace = await createWorkspace();
    const events: CodexClientEvent[] = [];
    const client = createClient("read-timeout", workspace, events, {
      readTimeoutMs: 50,
    });

    await expect(
      client.startSession({
        prompt: "Start",
        title: "ABC-123: Example",
      }),
    ).rejects.toMatchObject({
      name: "CodexAppServerClientError",
      code: ERROR_CODES.codexReadTimeout,
    } satisfies Partial<CodexAppServerClientError>);

    expect(events).toContainEqual(
      expect.objectContaining({
        event: "startup_failed",
      }),
    );
  });

  it("enforces per-turn timeouts after turn/start succeeds", async () => {
    const workspace = await createWorkspace();
    const events: CodexClientEvent[] = [];
    const client = createClient("turn-timeout", workspace, events, {
      turnTimeoutMs: 60,
      stallTimeoutMs: 500,
    });

    await expect(
      client.startSession({
        prompt: "Hang forever",
        title: "ABC-123: Example",
      }),
    ).rejects.toMatchObject({
      name: "CodexAppServerClientError",
      code: ERROR_CODES.codexTurnTimeout,
    } satisfies Partial<CodexAppServerClientError>);

    expect(events).toContainEqual(
      expect.objectContaining({
        event: "turn_ended_with_error",
        errorCode: ERROR_CODES.codexTurnTimeout,
      }),
    );

    await client.close();
  });

  it("disables stall detection when stallTimeoutMs is zero", async () => {
    const workspace = await createWorkspace();
    const events: CodexClientEvent[] = [];
    const client = createClient("turn-timeout", workspace, events, {
      stallTimeoutMs: 0,
      turnTimeoutMs: 50,
    });

    await expect(
      client.startSession({
        prompt: "Wait for turn timeout",
        title: "ABC-123: Example",
      }),
    ).rejects.toMatchObject({
      name: "CodexAppServerClientError",
      code: ERROR_CODES.codexTurnTimeout,
    } satisfies Partial<CodexAppServerClientError>);

    expect(events).toContainEqual(
      expect.objectContaining({
        event: "turn_ended_with_error",
        errorCode: ERROR_CODES.codexTurnTimeout,
      }),
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({
        event: "turn_ended_with_error",
        errorCode: ERROR_CODES.codexSessionStalled,
      }),
    );

    await client.close();
  });
});

function createClient(
  scenario: string,
  workspace: string,
  events: CodexClientEvent[],
  overrides?: Partial<{
    readTimeoutMs: number;
    turnTimeoutMs: number;
    stallTimeoutMs: number;
    dynamicTools: NonNullable<
      ConstructorParameters<typeof CodexAppServerClient>[0]["dynamicTools"]
    >;
  }>,
): CodexAppServerClient {
  return new CodexAppServerClient({
    command: `${process.execPath} "${fixturePath}" ${scenario}`,
    cwd: workspace,
    approvalPolicy: "full-auto",
    threadSandbox: "workspace-write",
    turnSandboxPolicy: {
      type: "workspace-write",
    },
    readTimeoutMs: overrides?.readTimeoutMs ?? 750,
    turnTimeoutMs: overrides?.turnTimeoutMs ?? 500,
    stallTimeoutMs: overrides?.stallTimeoutMs ?? 1_000,
    ...(overrides?.dynamicTools === undefined
      ? {}
      : { dynamicTools: overrides.dynamicTools }),
    onEvent: (event) => {
      events.push(event);
    },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "symphony-task9-"));
  const workspace = join(root, "ABC-123");
  await mkdir(workspace, { recursive: true });
  roots.push(root);
  return workspace;
}
