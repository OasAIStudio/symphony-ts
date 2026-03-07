import type { IncomingMessage, ServerResponse } from "node:http";

import type { RuntimeSnapshot } from "../logging/runtime-snapshot.js";
import type { DashboardServerHost } from "./dashboard-server.js";

export async function readSnapshot(
  host: DashboardServerHost,
  timeoutMs: number,
): Promise<RuntimeSnapshot> {
  return await withTimeout(host.getRuntimeSnapshot(), timeoutMs, () => {
    return new Error(`Runtime snapshot timed out after ${timeoutMs}ms.`);
  });
}

export function writeJson(
  response: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  const body = JSON.stringify(payload);
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", Buffer.byteLength(body));
  response.end(body);
}

export function writeHtml(
  response: ServerResponse,
  statusCode: number,
  html: string,
): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.setHeader("content-length", Buffer.byteLength(html));
  response.end(html);
}

export function writeNotFound(response: ServerResponse, path: string): void {
  response.statusCode = 404;
  response.setHeader("content-type", "text/plain; charset=utf-8");
  response.end(`Not found: ${path}`);
}

export async function readRequestBody(request: IncomingMessage): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    request.on("error", reject);
    request.on("end", resolve);
    request.resume();
  });
}

export function isSnapshotTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.startsWith("Runtime snapshot timed out after ")
  );
}

async function withTimeout<T>(
  promise: Promise<T> | T,
  timeoutMs: number,
  createError: () => Error,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(createError());
    }, timeoutMs);

    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (error) => {
        clearTimeout(timeout);
        reject(error);
      },
    );
  });
}
