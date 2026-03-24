import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";

import { ERROR_CODES } from "../errors/codes.js";
import { formatEasternTimestamp } from "../logging/format-timestamp.js";
import { VERSION } from "../version.js";

const DEFAULT_CLIENT_INFO = Object.freeze({
  name: "symphony-ts",
  version: VERSION,
});

const DEFAULT_MAX_LINE_BYTES = 10 * 1024 * 1024;

type JsonObject = Record<string, unknown>;
type JsonRpcId = string | number;

export interface CodexUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  noCacheTokens?: number;
  reasoningTokens?: number;
}

export type CodexTurnStatus = "completed" | "failed" | "cancelled";

export interface CodexClientEvent {
  event:
    | "session_started"
    | "startup_failed"
    | "turn_completed"
    | "turn_failed"
    | "turn_cancelled"
    | "turn_ended_with_error"
    | "turn_input_required"
    | "approval_auto_approved"
    | "unsupported_tool_call"
    | "notification"
    | "other_message"
    | "malformed"
    | "activity_heartbeat";
  timestamp: string;
  codexAppServerPid: string | null;
  sessionId?: string | null;
  threadId?: string | null;
  turnId?: string | null;
  usage?: CodexUsage;
  rateLimits?: Record<string, unknown> | null;
  errorCode?: string;
  message?: string;
  raw?: unknown;
  toolName?: string | null;
}

export interface CodexDynamicToolDefinition {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

export interface CodexDynamicTool extends CodexDynamicToolDefinition {
  execute: (input: unknown) => Promise<object>;
}

export interface CodexAppServerClientOptions {
  command: string;
  cwd: string;
  approvalPolicy: unknown;
  threadSandbox: unknown;
  turnSandboxPolicy: unknown;
  readTimeoutMs: number;
  turnTimeoutMs: number;
  stallTimeoutMs: number;
  clientInfo?: {
    name: string;
    version: string;
  };
  capabilities?: Record<string, unknown>;
  tools?: CodexDynamicToolDefinition[];
  dynamicTools?: CodexDynamicTool[];
  maxLineBytes?: number;
  onEvent?: (event: CodexClientEvent) => void;
}

export interface CodexStartSessionInput {
  prompt: string;
  title: string;
}

export interface CodexTurnResult {
  status: CodexTurnStatus;
  threadId: string;
  turnId: string;
  sessionId: string;
  usage: CodexUsage | null;
  rateLimits: Record<string, unknown> | null;
  message: string | null;
}

export class CodexAppServerClientError extends Error {
  readonly code: string;

  constructor(message: string, code: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CodexAppServerClientError";
    this.code = code;
  }
}

interface PendingRequest {
  readonly method: string;
  readonly resolve: (message: JsonObject) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

interface ActiveTurn {
  readonly threadId: string;
  readonly turnId: string;
  readonly sessionId: string;
  readonly resolve: (result: CodexTurnResult) => void;
  readonly reject: (error: Error) => void;
  readonly timeout: NodeJS.Timeout;
  stallTimer: NodeJS.Timeout | null;
}

export class CodexAppServerClient {
  private readonly options: CodexAppServerClientOptions;

  private child: ChildProcessWithoutNullStreams | null = null;
  private nextRequestId = 1;
  private stdoutBuffer = "";
  private threadId: string | null = null;
  private currentTurn: ActiveTurn | null = null;
  private lastUsage: CodexUsage | null = null;
  private lastRateLimits: Record<string, unknown> | null = null;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private startPromise: Promise<void> | null = null;
  private stderrBuffer = "";
  private closed = false;

  constructor(options: CodexAppServerClientOptions) {
    this.options = options;
  }

  async startSession(input: CodexStartSessionInput): Promise<CodexTurnResult> {
    await this.ensureStarted();

    const threadId = this.threadId;
    if (threadId === null) {
      throw new CodexAppServerClientError(
        "thread/start did not return a thread id.",
        ERROR_CODES.codexHandshakeFailed,
      );
    }

    return this.startTurn({
      threadId,
      prompt: input.prompt,
      title: input.title,
    });
  }

  async continueTurn(prompt: string, title: string): Promise<CodexTurnResult> {
    await this.ensureStarted();

    const threadId = this.threadId;
    if (threadId === null) {
      throw new CodexAppServerClientError(
        "Cannot continue a turn before a thread is started.",
        ERROR_CODES.codexHandshakeFailed,
      );
    }

    return this.startTurn({
      threadId,
      prompt,
      title,
    });
  }

  async close(): Promise<void> {
    this.closed = true;
    this.rejectPending(
      new CodexAppServerClientError(
        "Codex session closed.",
        ERROR_CODES.codexProtocolError,
      ),
    );

    if (this.currentTurn !== null) {
      this.finishTurnWithError(
        new CodexAppServerClientError(
          "Codex session closed while a turn was running.",
          ERROR_CODES.codexProtocolError,
        ),
        "turn_ended_with_error",
      );
    }

    const child = this.child;
    this.child = null;
    if (child === null) {
      return;
    }

    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
    }

    await new Promise<void>((resolve) => {
      child.once("exit", () => {
        resolve();
      });
    });
  }

  private async ensureStarted(): Promise<void> {
    if (this.child !== null) {
      return;
    }

    if (this.startPromise !== null) {
      await this.startPromise;
      return;
    }

    this.startPromise = this.spawnAndInitialize();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  private async spawnAndInitialize(): Promise<void> {
    try {
      this.child = spawn("bash", ["-lc", this.options.command], {
        cwd: this.options.cwd,
        stdio: "pipe",
      });
    } catch (error) {
      const wrapped = new CodexAppServerClientError(
        `Failed to launch Codex app-server: ${toErrorMessage(error)}`,
        ERROR_CODES.codexLaunchFailed,
        { cause: error },
      );
      this.emit({
        event: "startup_failed",
        errorCode: wrapped.code,
        message: wrapped.message,
      });
      throw wrapped;
    }

    const child = this.child;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk: string) => {
      this.handleStdoutChunk(chunk);
    });
    child.stderr.on("data", (chunk: string) => {
      this.handleStderrChunk(chunk);
    });
    child.on("error", (error) => {
      const wrapped = new CodexAppServerClientError(
        `Codex app-server process error: ${toErrorMessage(error)}`,
        ERROR_CODES.codexLaunchFailed,
        { cause: error },
      );
      this.emit({
        event: "startup_failed",
        errorCode: wrapped.code,
        message: wrapped.message,
      });
      this.rejectPending(wrapped);
      if (this.currentTurn !== null) {
        this.finishTurnWithError(wrapped, "turn_ended_with_error");
      }
    });
    child.on("exit", (code, signal) => {
      this.flushStderrBuffer();
      const error = new CodexAppServerClientError(
        `Codex app-server exited with code ${code ?? "null"} signal ${signal ?? "null"}.`,
        ERROR_CODES.codexProtocolError,
      );
      this.rejectPending(error);
      if (this.currentTurn !== null) {
        this.finishTurnWithError(error, "turn_ended_with_error");
      }
      if (!this.closed && this.threadId === null) {
        this.emit({
          event: "startup_failed",
          errorCode: error.code,
          message: error.message,
        });
      }
      this.child = null;
    });

    try {
      await this.request("initialize", {
        clientInfo: this.options.clientInfo ?? DEFAULT_CLIENT_INFO,
        capabilities: this.options.capabilities ?? {},
      });
      this.send({
        method: "initialized",
        params: {},
      });

      const threadResult = await this.request("thread/start", {
        approvalPolicy: this.options.approvalPolicy,
        sandbox: this.options.threadSandbox,
        cwd: this.options.cwd,
        tools: this.getAdvertisedTools(),
      });

      const threadId = extractNestedString(threadResult, [
        "result",
        "thread",
        "id",
      ]);
      if (threadId === null) {
        throw new CodexAppServerClientError(
          "thread/start did not include result.thread.id.",
          ERROR_CODES.codexHandshakeFailed,
        );
      }

      this.threadId = threadId;
    } catch (error) {
      const wrapped =
        error instanceof CodexAppServerClientError
          ? error
          : new CodexAppServerClientError(
              `Startup handshake failed: ${toErrorMessage(error)}`,
              ERROR_CODES.codexHandshakeFailed,
              { cause: error },
            );
      this.emit({
        event: "startup_failed",
        errorCode: wrapped.code,
        message: wrapped.message,
      });
      await this.close();
      throw wrapped;
    }
  }

  private async startTurn(input: {
    threadId: string;
    prompt: string;
    title: string;
  }): Promise<CodexTurnResult> {
    if (this.currentTurn !== null) {
      throw new CodexAppServerClientError(
        "Only one turn can run at a time.",
        ERROR_CODES.codexProtocolError,
      );
    }

    const response = await this.request("turn/start", {
      threadId: input.threadId,
      input: [
        {
          type: "text",
          text: input.prompt,
        },
      ],
      cwd: this.options.cwd,
      title: input.title,
      approvalPolicy: this.options.approvalPolicy,
      sandboxPolicy: this.options.turnSandboxPolicy,
    });

    const turnId = extractNestedString(response, ["result", "turn", "id"]);
    if (turnId === null) {
      throw new CodexAppServerClientError(
        "turn/start did not include result.turn.id.",
        ERROR_CODES.codexHandshakeFailed,
      );
    }

    const sessionId = `${input.threadId}-${turnId}`;
    this.emit({
      event: "session_started",
      sessionId,
      threadId: input.threadId,
      turnId,
    });

    return new Promise<CodexTurnResult>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.finishTurnWithError(
          new CodexAppServerClientError(
            `Codex turn exceeded ${this.options.turnTimeoutMs}ms.`,
            ERROR_CODES.codexTurnTimeout,
          ),
          "turn_ended_with_error",
        );
      }, this.options.turnTimeoutMs);

      const activeTurn: ActiveTurn = {
        threadId: input.threadId,
        turnId,
        sessionId,
        resolve,
        reject,
        timeout,
        stallTimer: null,
      };

      this.currentTurn = activeTurn;
      this.bumpStallTimer(activeTurn);
    });
  }

  private handleStdoutChunk(chunk: string): void {
    this.stdoutBuffer += chunk;

    if (Buffer.byteLength(this.stdoutBuffer, "utf8") > this.maxLineBytes) {
      this.emit({
        event: "malformed",
        errorCode: ERROR_CODES.codexProtocolError,
        message: "Codex stdout line exceeded the maximum buffered size.",
      });
      this.stdoutBuffer = "";
      return;
    }

    while (true) {
      const newlineIndex = this.stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }

      const rawLine = this.stdoutBuffer.slice(0, newlineIndex);
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIndex + 1);

      const line = rawLine.trim();
      if (line.length === 0) {
        continue;
      }

      this.handleStdoutLine(line);
    }
  }

  private handleStdoutLine(line: string): void {
    const parsed = parseJsonLine(line);
    if (parsed === null) {
      this.emit({
        event: "malformed",
        errorCode: ERROR_CODES.codexProtocolError,
        message: "Received non-JSON stdout line from Codex app-server.",
        raw: line,
      });
      return;
    }

    const usage = extractUsage(parsed);
    if (usage !== null) {
      this.lastUsage = usage;
    }

    const rateLimits = extractRateLimits(parsed);
    if (rateLimits !== null) {
      this.lastRateLimits = rateLimits;
    }

    if (this.currentTurn !== null) {
      this.bumpStallTimer(this.currentTurn);
    }

    const responseId = normalizeJsonRpcId(parsed.id);
    const method = typeof parsed.method === "string" ? parsed.method : null;

    if (responseId !== null && !("method" in parsed)) {
      const pending = this.pendingRequests.get(responseId);
      if (pending !== undefined) {
        clearTimeout(pending.timer);
        this.pendingRequests.delete(responseId);
        pending.resolve(parsed);
        return;
      }
    }

    if (isApprovalRequest(parsed, method)) {
      if (responseId !== null) {
        this.send({
          id: parsed.id,
          result: {
            approved: true,
          },
        });
      }
      this.emit({
        event: "approval_auto_approved",
        sessionId: this.currentTurn?.sessionId ?? null,
        threadId: this.currentTurn?.threadId ?? this.threadId,
        turnId: this.currentTurn?.turnId ?? null,
        raw: parsed,
        ...optionalTelemetry(this.lastUsage, this.lastRateLimits),
      });
      return;
    }

    if (isToolCallRequest(parsed, method)) {
      const toolName = extractToolName(parsed);
      const tool = toolName === null ? null : this.findDynamicTool(toolName);
      if (tool !== null && responseId !== null) {
        void this.handleDynamicToolCall(responseId, tool, parsed);
        return;
      }

      if (responseId !== null) {
        this.send({
          id: parsed.id,
          result: {
            success: false,
            error: {
              code: ERROR_CODES.codexDynamicToolRejected,
              message: `Unsupported tool call: ${toolName ?? "unknown"}`,
            },
          },
        });
      }
      this.emit({
        event: "unsupported_tool_call",
        sessionId: this.currentTurn?.sessionId ?? null,
        threadId: this.currentTurn?.threadId ?? this.threadId,
        turnId: this.currentTurn?.turnId ?? null,
        toolName,
        raw: parsed,
        ...optionalTelemetry(this.lastUsage, this.lastRateLimits),
      });
      return;
    }

    if (isUserInputRequired(parsed, method)) {
      const error = new CodexAppServerClientError(
        "Codex requested operator input during a turn.",
        ERROR_CODES.codexUserInputRequired,
      );
      this.emit({
        event: "turn_input_required",
        sessionId: this.currentTurn?.sessionId ?? null,
        threadId: this.currentTurn?.threadId ?? this.threadId,
        turnId: this.currentTurn?.turnId ?? null,
        errorCode: error.code,
        message: error.message,
        raw: parsed,
        ...optionalTelemetry(this.lastUsage, this.lastRateLimits),
      });
      this.finishTurnWithError(error, "turn_ended_with_error");
      return;
    }

    if (method === "turn/completed") {
      this.completeTurn("completed", usage, rateLimits, parsed);
      return;
    }

    if (method === "turn/failed") {
      this.completeTurn("failed", usage, rateLimits, parsed);
      return;
    }

    if (method === "turn/cancelled") {
      this.completeTurn("cancelled", usage, rateLimits, parsed);
      return;
    }

    if (method !== null) {
      this.emit({
        event: "notification",
        sessionId: this.currentTurn?.sessionId ?? null,
        threadId: this.currentTurn?.threadId ?? this.threadId,
        turnId: this.currentTurn?.turnId ?? null,
        message: method,
        raw: parsed,
        ...optionalTelemetry(this.lastUsage, this.lastRateLimits),
      });
      return;
    }

    this.emit({
      event: "other_message",
      sessionId: this.currentTurn?.sessionId ?? null,
      threadId: this.currentTurn?.threadId ?? this.threadId,
      turnId: this.currentTurn?.turnId ?? null,
      raw: parsed,
      ...optionalTelemetry(this.lastUsage, this.lastRateLimits),
    });
  }

  private handleStderrChunk(chunk: string): void {
    this.stderrBuffer += chunk;

    while (true) {
      const newlineIndex = this.stderrBuffer.indexOf("\n");
      if (newlineIndex === -1) {
        break;
      }

      const rawLine = this.stderrBuffer.slice(0, newlineIndex);
      this.stderrBuffer = this.stderrBuffer.slice(newlineIndex + 1);

      const line = rawLine.trim();
      if (line.length === 0) {
        continue;
      }

      this.emit({
        event: "other_message",
        sessionId: this.currentTurn?.sessionId ?? null,
        threadId: this.currentTurn?.threadId ?? this.threadId,
        turnId: this.currentTurn?.turnId ?? null,
        message: line,
        raw: {
          stream: "stderr",
          line,
        },
      });
    }
  }

  private flushStderrBuffer(): void {
    const line = this.stderrBuffer.trim();
    this.stderrBuffer = "";
    if (line.length === 0) {
      return;
    }

    this.emit({
      event: "other_message",
      sessionId: this.currentTurn?.sessionId ?? null,
      threadId: this.currentTurn?.threadId ?? this.threadId,
      turnId: this.currentTurn?.turnId ?? null,
      message: line,
      raw: {
        stream: "stderr",
        line,
      },
    });
  }

  private completeTurn(
    status: CodexTurnStatus,
    usage: CodexUsage | null,
    rateLimits: Record<string, unknown> | null,
    raw: JsonObject,
  ): void {
    const activeTurn = this.currentTurn;
    if (activeTurn === null) {
      return;
    }

    clearTimeout(activeTurn.timeout);
    clearTimeoutIfPresent(activeTurn.stallTimer);
    this.currentTurn = null;

    const result: CodexTurnResult = {
      status,
      threadId: activeTurn.threadId,
      turnId: activeTurn.turnId,
      sessionId: activeTurn.sessionId,
      usage: usage ?? this.lastUsage,
      rateLimits: rateLimits ?? this.lastRateLimits,
      message: extractTurnMessage(raw),
    };

    this.emit({
      event:
        status === "completed"
          ? "turn_completed"
          : status === "failed"
            ? "turn_failed"
            : "turn_cancelled",
      sessionId: activeTurn.sessionId,
      threadId: activeTurn.threadId,
      turnId: activeTurn.turnId,
      raw,
      ...(result.message === null ? {} : { message: result.message }),
      ...optionalTelemetry(result.usage, result.rateLimits),
    });

    activeTurn.resolve(result);
  }

  private finishTurnWithError(
    error: CodexAppServerClientError,
    event: "turn_ended_with_error",
  ): void {
    const activeTurn = this.currentTurn;
    if (activeTurn === null) {
      return;
    }

    clearTimeout(activeTurn.timeout);
    clearTimeoutIfPresent(activeTurn.stallTimer);
    this.currentTurn = null;

    this.emit({
      event,
      sessionId: activeTurn.sessionId,
      threadId: activeTurn.threadId,
      turnId: activeTurn.turnId,
      errorCode: error.code,
      message: error.message,
      ...optionalTelemetry(this.lastUsage, this.lastRateLimits),
    });

    activeTurn.reject(error);
  }

  private bumpStallTimer(activeTurn: ActiveTurn): void {
    clearTimeoutIfPresent(activeTurn.stallTimer);

    if (this.options.stallTimeoutMs <= 0) {
      activeTurn.stallTimer = null;
      return;
    }

    activeTurn.stallTimer = setTimeout(() => {
      this.finishTurnWithError(
        new CodexAppServerClientError(
          `Codex session stalled for ${this.options.stallTimeoutMs}ms.`,
          ERROR_CODES.codexSessionStalled,
        ),
        "turn_ended_with_error",
      );
    }, this.options.stallTimeoutMs);
  }

  private request(method: string, params: JsonObject): Promise<JsonObject> {
    const id = this.nextRequestId++;

    return new Promise<JsonObject>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(String(id));
        reject(
          new CodexAppServerClientError(
            `Timed out waiting for ${method} response after ${this.options.readTimeoutMs}ms.`,
            ERROR_CODES.codexReadTimeout,
          ),
        );
      }, this.options.readTimeoutMs);

      this.pendingRequests.set(String(id), {
        method,
        resolve,
        reject,
        timer,
      });

      this.send({
        id,
        method,
        params,
      });
    });
  }

  private send(message: JsonObject): void {
    const child = this.child;
    if (child === null || child.stdin.destroyed) {
      throw new CodexAppServerClientError(
        "Codex app-server process is not writable.",
        ERROR_CODES.codexProtocolError,
      );
    }

    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }

  private emit(
    input: Omit<CodexClientEvent, "timestamp" | "codexAppServerPid">,
  ): void {
    this.options.onEvent?.({
      ...input,
      timestamp: formatEasternTimestamp(new Date()),
      codexAppServerPid:
        this.child?.pid === undefined ? null : String(this.child.pid),
    });
  }

  private get maxLineBytes(): number {
    return this.options.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  }

  private getAdvertisedTools(): CodexDynamicToolDefinition[] {
    const advertised = new Map<string, CodexDynamicToolDefinition>();

    for (const tool of this.options.tools ?? []) {
      advertised.set(tool.name, tool);
    }

    for (const tool of this.options.dynamicTools ?? []) {
      advertised.set(tool.name, {
        name: tool.name,
        ...(tool.description === undefined
          ? {}
          : { description: tool.description }),
        ...(tool.inputSchema === undefined
          ? {}
          : { inputSchema: tool.inputSchema }),
      });
    }

    return [...advertised.values()];
  }

  private findDynamicTool(name: string): CodexDynamicTool | null {
    return (
      this.options.dynamicTools?.find((tool) => tool.name === name) ?? null
    );
  }

  private async handleDynamicToolCall(
    requestId: JsonRpcId,
    tool: CodexDynamicTool,
    message: JsonObject,
  ): Promise<void> {
    try {
      const result = await tool.execute(extractToolInput(message));
      this.send({
        id: requestId,
        result,
      });
    } catch (error) {
      this.send({
        id: requestId,
        result: {
          success: false,
          error: {
            code: ERROR_CODES.codexDynamicToolRejected,
            message: `Dynamic tool ${tool.name} failed: ${toErrorMessage(error)}`,
          },
        },
      });
    }
  }
}

function parseJsonLine(line: string): JsonObject | null {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    return parsed as JsonObject;
  } catch {
    return null;
  }
}

function normalizeJsonRpcId(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return null;
}

function isApprovalRequest(
  message: JsonObject,
  method: string | null,
): boolean {
  if (method === null) {
    return false;
  }

  const normalized = method.toLowerCase();
  if (normalized.includes("approval")) {
    return true;
  }

  return containsStringValue(message, "approval");
}

function isToolCallRequest(
  message: JsonObject,
  method: string | null,
): boolean {
  if (method === null) {
    return false;
  }

  const normalized = method.toLowerCase();
  if (
    normalized.includes("tool/call") ||
    normalized.includes("item/tool/call") ||
    normalized.includes("tool_call")
  ) {
    return true;
  }

  return false;
}

function isUserInputRequired(
  message: JsonObject,
  method: string | null,
): boolean {
  if (method !== null) {
    const normalized = method.toLowerCase();
    if (
      (normalized.includes("input") && normalized.includes("required")) ||
      (normalized.includes("user") && normalized.includes("input"))
    ) {
      return true;
    }
  }

  return containsStringValue(message, "user_input_required");
}

function extractToolName(message: JsonObject): string | null {
  const directNames = [
    extractNestedString(message, ["params", "toolName"]),
    extractNestedString(message, ["params", "name"]),
    extractNestedString(message, ["params", "tool", "name"]),
    extractNestedString(message, ["name"]),
  ];

  return directNames.find((value) => value !== null) ?? null;
}

function extractToolInput(message: JsonObject): unknown {
  const params =
    message.params !== null &&
    typeof message.params === "object" &&
    !Array.isArray(message.params)
      ? (message.params as JsonObject)
      : null;

  if (params === null) {
    return undefined;
  }

  const candidates = [
    params.input,
    params.arguments,
    params.args,
    params.payload,
    params.toolInput,
  ];

  for (const candidate of candidates) {
    if (candidate !== undefined) {
      return candidate;
    }
  }

  return undefined;
}

function extractUsage(message: JsonObject): CodexUsage | null {
  for (const candidate of walkObjects(message)) {
    const usage = coerceUsage(candidate);
    if (usage !== null) {
      return usage;
    }
  }
  return null;
}

function coerceUsage(value: JsonObject): CodexUsage | null {
  const specificAliases = [
    ["inputTokens", "outputTokens", "totalTokens"],
    ["input_tokens", "output_tokens", "total_tokens"],
  ] as const;

  // Check specific aliases first (input + output sufficient)
  for (const [inputKey, outputKey, totalKey] of specificAliases) {
    const input = asFiniteNumber(value[inputKey]);
    const output = asFiniteNumber(value[outputKey]);
    const total = asFiniteNumber(value[totalKey]);
    // Accept usage if at least input and output are present; total is optional.
    if (input !== null && output !== null) {
      return {
        inputTokens: input,
        outputTokens: output,
        totalTokens: total ?? input + output,
        ...extractExtendedTokenFields(value),
      };
    }
  }

  // Check generic alias (require all 3 fields to avoid false matches)
  const genericInput = asFiniteNumber(value.input);
  const genericOutput = asFiniteNumber(value.output);
  const genericTotal = asFiniteNumber(value.total);
  if (
    genericInput !== null &&
    genericOutput !== null &&
    genericTotal !== null
  ) {
    return {
      inputTokens: genericInput,
      outputTokens: genericOutput,
      totalTokens: genericTotal,
      ...extractExtendedTokenFields(value),
    };
  }

  if ("total_token_usage" in value) {
    const nested = value.total_token_usage;
    if (
      nested !== null &&
      typeof nested === "object" &&
      !Array.isArray(nested)
    ) {
      return coerceUsage(nested as JsonObject);
    }
  }

  return null;
}

/**
 * Extract optional extended token fields (cache, reasoning) from a usage object.
 * Handles both camelCase and snake_case variants.
 */
function extractExtendedTokenFields(
  value: JsonObject,
): Partial<
  Pick<
    CodexUsage,
    "cacheReadTokens" | "cacheWriteTokens" | "noCacheTokens" | "reasoningTokens"
  >
> {
  const result: Partial<
    Pick<
      CodexUsage,
      | "cacheReadTokens"
      | "cacheWriteTokens"
      | "noCacheTokens"
      | "reasoningTokens"
    >
  > = {};

  const cacheRead =
    asFiniteNumber(value.cacheReadTokens) ??
    asFiniteNumber(value.cache_read_tokens) ??
    asFiniteNumber(value.cache_read_input_tokens);
  if (cacheRead !== null) {
    result.cacheReadTokens = cacheRead;
  }

  const cacheWrite =
    asFiniteNumber(value.cacheWriteTokens) ??
    asFiniteNumber(value.cache_write_tokens) ??
    asFiniteNumber(value.cache_creation_input_tokens);
  if (cacheWrite !== null) {
    result.cacheWriteTokens = cacheWrite;
  }

  const noCache =
    asFiniteNumber(value.noCacheTokens) ??
    asFiniteNumber(value.no_cache_tokens);
  if (noCache !== null) {
    result.noCacheTokens = noCache;
  }

  const reasoning =
    asFiniteNumber(value.reasoningTokens) ??
    asFiniteNumber(value.reasoning_tokens);
  if (reasoning !== null) {
    result.reasoningTokens = reasoning;
  }

  return result;
}

function extractRateLimits(
  message: JsonObject,
): Record<string, unknown> | null {
  for (const candidate of walkObjects(message)) {
    if ("rateLimits" in candidate) {
      const nested = candidate.rateLimits;
      if (
        nested !== null &&
        typeof nested === "object" &&
        !Array.isArray(nested)
      ) {
        return nested as Record<string, unknown>;
      }
    }
    if ("rate_limits" in candidate) {
      const nested = candidate.rate_limits;
      if (
        nested !== null &&
        typeof nested === "object" &&
        !Array.isArray(nested)
      ) {
        return nested as Record<string, unknown>;
      }
    }
  }
  return null;
}

function extractTurnMessage(message: JsonObject): string | null {
  const direct = [
    extractNestedString(message, ["params", "message"]),
    extractNestedString(message, ["params", "summary"]),
    extractNestedString(message, ["result", "message"]),
    extractNestedString(message, ["message"]),
  ];

  return direct.find((value) => value !== null) ?? null;
}

function extractNestedString(
  source: JsonObject,
  path: readonly string[],
): string | null {
  let current: unknown = source;
  for (const segment of path) {
    if (
      current === null ||
      typeof current !== "object" ||
      Array.isArray(current)
    ) {
      return null;
    }
    current = (current as JsonObject)[segment];
  }

  return typeof current === "string" && current.length > 0 ? current : null;
}

function* walkObjects(value: unknown): Generator<JsonObject> {
  if (value === null || typeof value !== "object") {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      yield* walkObjects(entry);
    }
    return;
  }

  const objectValue = value as JsonObject;
  yield objectValue;
  for (const nested of Object.values(objectValue)) {
    yield* walkObjects(nested);
  }
}

function containsStringValue(value: unknown, expected: string): boolean {
  const target = expected.toLowerCase();
  if (typeof value === "string") {
    return value.toLowerCase().includes(target);
  }
  if (Array.isArray(value)) {
    return value.some((entry) => containsStringValue(entry, expected));
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).some((entry) =>
      containsStringValue(entry, expected),
    );
  }
  return false;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function clearTimeoutIfPresent(timer: NodeJS.Timeout | null): void {
  if (timer !== null) {
    clearTimeout(timer);
  }
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function optionalTelemetry(
  usage: CodexUsage | null,
  rateLimits: Record<string, unknown> | null,
): Partial<Pick<CodexClientEvent, "usage" | "rateLimits">> {
  return {
    ...(usage === null ? {} : { usage }),
    ...(rateLimits === null ? {} : { rateLimits }),
  };
}
