import type { IncomingMessage, ServerResponse } from "node:http";

import { ERROR_CODES } from "../errors/codes.js";
import type { RuntimeSnapshot } from "../logging/runtime-snapshot.js";
import { toErrorMessage } from "./dashboard-format.js";
import { isSnapshotTimeoutError, readSnapshot } from "./dashboard-http.js";
import type { DashboardServerHost } from "./dashboard-server.js";

export class DashboardLiveUpdatesController {
  readonly #host: DashboardServerHost;
  readonly #snapshotTimeoutMs: number;
  readonly #refreshMs: number;
  readonly #renderIntervalMs: number;
  readonly #clients = new Set<ServerResponse<IncomingMessage>>();
  #flushTimer: NodeJS.Timeout | null = null;
  #heartbeatTimer: NodeJS.Timeout | null = null;
  #unsubscribeHost: (() => void) | null = null;
  #closed = false;

  constructor(options: {
    host: DashboardServerHost;
    snapshotTimeoutMs: number;
    refreshMs: number;
    renderIntervalMs: number;
  }) {
    this.#host = options.host;
    this.#snapshotTimeoutMs = options.snapshotTimeoutMs;
    this.#refreshMs = options.refreshMs;
    this.#renderIntervalMs = options.renderIntervalMs;
  }

  start(): void {
    if (typeof this.#host.subscribeToSnapshots === "function") {
      this.#unsubscribeHost = this.#host.subscribeToSnapshots(() => {
        this.scheduleBroadcast();
      });
    }
  }

  async close(): Promise<void> {
    this.#closed = true;
    this.#unsubscribeHost?.();
    this.#unsubscribeHost = null;
    this.clearTimers();

    for (const client of this.#clients) {
      client.end();
    }
    this.#clients.clear();
  }

  async handleEventsRequest(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    response.statusCode = 200;
    response.setHeader("content-type", "text/event-stream; charset=utf-8");
    response.setHeader("cache-control", "no-cache, no-transform");
    response.setHeader("connection", "keep-alive");
    response.setHeader("x-accel-buffering", "no");
    response.write(`retry: ${this.#refreshMs}\n\n`);

    this.#clients.add(response);
    this.startHeartbeat();

    const cleanup = () => {
      this.#clients.delete(response);
      if (this.#clients.size === 0) {
        this.stopHeartbeat();
      }
    };

    request.on("close", cleanup);
    response.on("close", cleanup);

    await this.writeSnapshot(response);
  }

  scheduleBroadcast(): void {
    if (this.#closed || this.#clients.size === 0 || this.#flushTimer !== null) {
      return;
    }

    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      void this.broadcastSnapshot();
    }, this.#renderIntervalMs);
  }

  private startHeartbeat(): void {
    if (this.#heartbeatTimer !== null) {
      return;
    }

    this.#heartbeatTimer = setInterval(() => {
      this.scheduleBroadcast();
    }, this.#refreshMs);
  }

  private stopHeartbeat(): void {
    if (this.#heartbeatTimer === null) {
      return;
    }

    clearInterval(this.#heartbeatTimer);
    this.#heartbeatTimer = null;
  }

  private clearTimers(): void {
    if (this.#flushTimer !== null) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    this.stopHeartbeat();
  }

  private async broadcastSnapshot(): Promise<void> {
    const clients = [...this.#clients];
    if (clients.length === 0) {
      return;
    }

    await Promise.allSettled(
      clients.map((client) => this.writeSnapshot(client)),
    );
  }

  private async writeSnapshot(response: ServerResponse): Promise<void> {
    try {
      const snapshot: RuntimeSnapshot = await readSnapshot(
        this.#host,
        this.#snapshotTimeoutMs,
      );
      response.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
    } catch (error) {
      response.write(
        `event: error\ndata: ${JSON.stringify({
          code: isSnapshotTimeoutError(error)
            ? ERROR_CODES.snapshotTimedOut
            : ERROR_CODES.snapshotUnavailable,
          message: toErrorMessage(error),
        })}\n\n`,
      );
    }
  }
}
