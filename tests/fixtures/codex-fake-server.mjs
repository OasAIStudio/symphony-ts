import { realpathSync } from "node:fs";
import process from "node:process";
import readline from "node:readline";

const scenario = process.argv[2] ?? "happy";
const requests = [];
let turnCount = 0;

const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Number.POSITIVE_INFINITY,
});

rl.on("line", async (line) => {
  if (line.trim().length === 0) {
    return;
  }

  const message = JSON.parse(line);
  requests.push(message);

  try {
    await handleMessage(message);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
});

async function handleMessage(message) {
  if (message.method === "initialize") {
    if (scenario === "read-timeout") {
      return;
    }

    if (scenario === "handshake") {
      assertEqual(
        message.params.clientInfo?.name,
        "symphony-ts",
        "initialize must include clientInfo.name",
      );
      assertEqual(
        typeof message.params.clientInfo?.version,
        "string",
        "initialize must include clientInfo.version",
      );
      assertEqual(
        typeof message.params.capabilities,
        "object",
        "initialize must include a capabilities object",
      );
    }

    writeJson({
      id: message.id,
      result: {
        serverInfo: {
          name: "fake-codex",
        },
      },
    });
    return;
  }

  if (message.method === "thread/start") {
    assertEqual(
      realpathSync(process.cwd()),
      realpathSync(message.params.cwd),
      "spawn cwd must equal request cwd",
    );
    if (scenario === "linear-tool") {
      assertEqual(
        message.params.tools?.[0]?.name,
        "linear_graphql",
        "thread/start must advertise linear_graphql",
      );
    }
    if (scenario === "handshake") {
      assertEqual(
        message.params.approvalPolicy,
        "full-auto",
        "thread/start must include approvalPolicy",
      );
      assertEqual(
        message.params.sandbox,
        "workspace-write",
        "thread/start must include thread sandbox policy",
      );
    }
    writeJson({
      id: message.id,
      result: {
        thread: {
          id: "thread-1",
        },
      },
    });
    return;
  }

  if (message.method === "turn/start") {
    turnCount += 1;
    assertEqual(message.params.threadId, "thread-1", "threadId must be reused");
    assertEqual(
      realpathSync(process.cwd()),
      realpathSync(message.params.cwd),
      "turn cwd must equal workspace path",
    );
    assertEqual(
      message.params.input?.[0]?.type,
      "text",
      "turn input must contain a single text item",
    );
    if (scenario === "handshake") {
      assertEqual(
        message.params.approvalPolicy,
        "full-auto",
        "turn/start must include approvalPolicy",
      );
      assertEqual(
        message.params.sandboxPolicy?.type,
        "workspace-write",
        "turn/start must include per-turn sandbox policy",
      );
    }

    writeJson({
      id: message.id,
      result: {
        turn: {
          id: `turn-${turnCount}`,
        },
      },
    });

    if (scenario === "turn-timeout") {
      return;
    }

    if (scenario === "user-input") {
      setTimeout(() => {
        writeJson({
          method: "turn/input_required",
          params: {
            reason: "Please confirm.",
          },
        });
      }, 10);
      return;
    }

    if (scenario === "user-input-variant") {
      setTimeout(() => {
        writeJson({
          method: "turn/user_input_required",
          params: {
            reason: "Please confirm.",
          },
        });
      }, 10);
      return;
    }

    if (turnCount === 1) {
      setTimeout(() => {
        process.stderr.write("diagnostic from stderr\n");

        writePartialJson({
          method: "turn/update",
          params: {
            total_token_usage: {
              input_tokens: 11,
              output_tokens: 7,
              total_tokens: 18,
            },
          },
        });

        setTimeout(() => {
          writeJson({
            id: "approval-1",
            method:
              scenario === "payload-variants"
                ? "turn/approval_required"
                : "approval/request",
            params: {
              kind: "command_execution",
            },
          });
        }, 10);
      }, 10);
      return;
    }

    setTimeout(() => {
      writeJson({
        method: "turn/completed",
        params: {
          message: "Second turn finished",
          result:
            scenario === "payload-variants"
              ? {
                  telemetry: {
                    usage: {
                      input_tokens: 20,
                      output_tokens: 10,
                      total_tokens: 30,
                    },
                  },
                  rate_limits: {
                    requests_remaining: 9,
                    tokens_remaining: 999,
                  },
                }
              : {
                  rate_limits: {
                    requests_remaining: 9,
                    tokens_remaining: 999,
                  },
                },
          ...(scenario === "payload-variants"
            ? {}
            : {
                usage: {
                  inputTokens: 20,
                  outputTokens: 10,
                  totalTokens: 30,
                },
              }),
        },
      });
    }, 10);
    return;
  }

  if (message.id === "approval-1") {
    assertEqual(
      message.result?.approved,
      true,
      "approval must be auto-approved",
    );

    setTimeout(() => {
      writeJson({
        id: "tool-1",
        method: "item/tool/call",
        params: {
          toolName:
            scenario === "linear-tool" ? "linear_graphql" : "not_supported",
          input:
            scenario === "linear-tool"
              ? {
                  query: "query Viewer { viewer { id name } }",
                  variables: {
                    includeArchived: false,
                  },
                }
              : undefined,
        },
      });
    }, 10);
    return;
  }

  if (message.id === "tool-1") {
    if (scenario === "linear-tool") {
      assertEqual(
        message.result?.success,
        true,
        "supported linear_graphql tool call must succeed",
      );
      assertEqual(
        message.result?.response?.body?.data?.viewer?.id,
        "viewer-1",
        "linear_graphql tool must return the GraphQL response body",
      );
    } else {
      assertEqual(
        message.result?.success,
        false,
        "unsupported tool calls must return success=false",
      );
    }

    setTimeout(() => {
      writeJson({
        method: "turn/completed",
        params: {
          message: "First turn finished",
          usage: {
            inputTokens: 14,
            outputTokens: 9,
            totalTokens: 23,
          },
          rateLimits: {
            requestsRemaining: 10,
            tokensRemaining: 1000,
          },
        },
      });
    }, 10);
  }
}

function writeJson(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function writePartialJson(message) {
  const encoded = `${JSON.stringify(message)}\n`;
  const halfway = Math.floor(encoded.length / 2);
  process.stdout.write(encoded.slice(0, halfway));
  setTimeout(() => {
    process.stdout.write(encoded.slice(halfway));
  }, 5);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, received ${actual}`);
  }
}
