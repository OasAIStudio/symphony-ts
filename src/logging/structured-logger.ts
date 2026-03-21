import type { Writable } from "node:stream";

import type { LogField } from "./fields.js";
import { formatEasternTimestamp } from "./format-timestamp.js";

export type StructuredLogLevel = "debug" | "info" | "warn" | "error";

export interface StructuredLogEntry {
  timestamp: string;
  level: StructuredLogLevel;
  event: string;
  message: string;
  outcome?: string;
  reason?: string;
  issue_id?: string;
  issue_identifier?: string;
  session_id?: string | null;
  thread_id?: string | null;
  turn_id?: string | null;
  attempt?: number | null;
  state?: string;
  workspace_path?: string;
  poll_interval_ms?: number;
  max_concurrent_agents?: number;
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
  rate_limit_requests_remaining?: number;
  rate_limit_tokens_remaining?: number;
  duration_ms?: number;
  seconds_running?: number;
  error_code?: string;
  [key: string]: unknown;
}

export interface StructuredLogSink {
  write(entry: StructuredLogEntry): void | Promise<void>;
}

export interface StructuredLoggerOptions {
  now?: () => Date;
}

export class StructuredLogger {
  private readonly sinks: StructuredLogSink[];
  private readonly now: () => Date;

  constructor(sinks: StructuredLogSink[], options?: StructuredLoggerOptions) {
    this.sinks = sinks.slice();
    this.now = options?.now ?? (() => new Date());
  }

  async debug(
    event: string,
    message: string,
    context?: StructuredLogContext,
  ): Promise<StructuredLogEntry> {
    return this.log("debug", event, message, context);
  }

  async info(
    event: string,
    message: string,
    context?: StructuredLogContext,
  ): Promise<StructuredLogEntry> {
    return this.log("info", event, message, context);
  }

  async warn(
    event: string,
    message: string,
    context?: StructuredLogContext,
  ): Promise<StructuredLogEntry> {
    return this.log("warn", event, message, context);
  }

  async error(
    event: string,
    message: string,
    context?: StructuredLogContext,
  ): Promise<StructuredLogEntry> {
    return this.log("error", event, message, context);
  }

  async log(
    level: StructuredLogLevel,
    event: string,
    message: string,
    context?: StructuredLogContext,
  ): Promise<StructuredLogEntry> {
    const entry = createStructuredLogEntry(
      { level, event, message },
      context,
      this.now(),
    );

    if (this.sinks.length === 0) {
      return entry;
    }

    const failedSinks: unknown[] = [];
    await Promise.all(
      this.sinks.map(async (sink) => {
        try {
          await sink.write(entry);
        } catch (error) {
          failedSinks.push(error);
        }
      }),
    );

    if (failedSinks.length > 0 && failedSinks.length < this.sinks.length) {
      const warning = createStructuredLogEntry(
        {
          level: "warn",
          event: "log_sink_failed",
          message:
            "event=log_sink_failed outcome=degraded reason=sink_write_failed",
        },
        {
          outcome: "degraded",
          reason: "sink_write_failed",
        },
        this.now(),
      );

      await Promise.all(
        this.sinks.map(async (sink) => {
          try {
            await sink.write(warning);
          } catch {
            // Keep logging failure handling non-fatal.
          }
        }),
      );
    }

    return entry;
  }
}

export type StructuredLogContext = Partial<
  Omit<StructuredLogEntry, "timestamp" | "level" | "event" | "message">
>;

export function createStructuredLogEntry(
  base: {
    level: StructuredLogLevel;
    event: string;
    message: string;
  },
  context: StructuredLogContext | undefined,
  now = new Date(),
): StructuredLogEntry {
  const merged: StructuredLogEntry = {
    timestamp: formatEasternTimestamp(now),
    level: base.level,
    event: base.event,
    message: formatStructuredMessage(base.event, base.message, context),
    ...context,
  };

  return merged;
}

export function formatStructuredMessage(
  event: string,
  message: string,
  context?: StructuredLogContext,
): string {
  const parts = [`event=${quoteValue(event)}`];
  const orderedKeys = LOG_MESSAGE_FIELDS.filter((field) => {
    const value = context?.[field];
    return value !== undefined && value !== null;
  });

  for (const field of orderedKeys) {
    parts.push(`${field}=${quoteValue(context?.[field])}`);
  }

  if (message.trim().length > 0) {
    parts.push(`message=${quoteValue(message.trim())}`);
  }

  for (const [key, value] of Object.entries(context ?? {})) {
    if (
      orderedKeys.includes(key as LogField) ||
      value === undefined ||
      value === null
    ) {
      continue;
    }
    parts.push(`${key}=${quoteValue(value)}`);
  }

  return parts.join(" ");
}

export function createJsonLineSink(stream: Writable): StructuredLogSink {
  return {
    write(entry) {
      stream.write(`${JSON.stringify(entry)}\n`);
    },
  };
}

const LOG_MESSAGE_FIELDS: readonly LogField[] = [
  "outcome",
  "reason",
  "issue_id",
  "issue_identifier",
  "session_id",
  "thread_id",
  "turn_id",
  "attempt",
  "state",
  "workspace_path",
  "poll_interval_ms",
  "max_concurrent_agents",
  "input_tokens",
  "output_tokens",
  "total_tokens",
  "rate_limit_requests_remaining",
  "rate_limit_tokens_remaining",
  "duration_ms",
  "seconds_running",
  "error_code",
];

function quoteValue(value: unknown): string {
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }

  const text = String(value ?? "");
  if (/^[A-Za-z0-9._:/-]+$/.test(text)) {
    return text;
  }

  return JSON.stringify(text);
}
