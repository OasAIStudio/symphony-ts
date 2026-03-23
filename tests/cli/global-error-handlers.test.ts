import type { MockInstance } from "vitest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockWriteSync = vi.hoisted(() => vi.fn());

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    writeSync: mockWriteSync,
  };
});

import {
  handleUncaughtException,
  handleUnhandledRejection,
} from "../../src/cli/main.js";

describe("global error handlers", () => {
  let exitSpy: MockInstance;

  beforeEach(() => {
    mockWriteSync.mockReturnValue(0);
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);
  });

  afterEach(() => {
    process.exitCode = undefined;
    mockWriteSync.mockClear();
    vi.restoreAllMocks();
  });

  it("handleUncaughtException logs structured JSON and exits with code 70", () => {
    const error = new Error("kaboom");

    handleUncaughtException(error);

    expect(mockWriteSync).toHaveBeenCalledOnce();
    const written = mockWriteSync.mock.calls[0]![1] as string;
    const entry = JSON.parse(written.trimEnd());

    expect(entry.level).toBe("error");
    expect(entry.event).toBe("process_crash");
    expect(entry.error_code).toBe("uncaught_exception");
    expect(entry.message).toBe("kaboom");
    expect(entry.stack).toContain("kaboom");
    expect(entry.timestamp).toBeDefined();
    expect(process.exitCode).toBe(70);
    expect(exitSpy).toHaveBeenCalledWith(70);
  });

  it("handleUncaughtException handles non-Error values", () => {
    handleUncaughtException("string rejection");

    const written = mockWriteSync.mock.calls[0]![1] as string;
    const entry = JSON.parse(written.trimEnd());

    expect(entry.message).toBe("string rejection");
    expect(entry.stack).toBeUndefined();
    expect(entry.error_code).toBe("uncaught_exception");
  });

  it("handleUncaughtException handles non-stringifiable values", () => {
    const obj = Object.create(null);
    obj.toString = () => {
      throw new Error("toString threw");
    };

    handleUncaughtException(obj);

    const written = mockWriteSync.mock.calls[0]![1] as string;
    const entry = JSON.parse(written.trimEnd());

    expect(entry.message).toBe("[non-stringifiable value]");
    expect(entry.stack).toBeUndefined();
    expect(entry.error_code).toBe("uncaught_exception");
  });

  it("handleUnhandledRejection logs structured JSON and exits with code 70", () => {
    const reason = new Error("promise failed");

    handleUnhandledRejection(reason);

    expect(mockWriteSync).toHaveBeenCalledOnce();
    const written = mockWriteSync.mock.calls[0]![1] as string;
    const entry = JSON.parse(written.trimEnd());

    expect(entry.level).toBe("error");
    expect(entry.event).toBe("process_crash");
    expect(entry.error_code).toBe("unhandled_rejection");
    expect(entry.message).toBe("promise failed");
    expect(entry.stack).toContain("promise failed");
    expect(process.exitCode).toBe(70);
    expect(exitSpy).toHaveBeenCalledWith(70);
  });

  it("handleUnhandledRejection handles non-Error values", () => {
    handleUnhandledRejection(42);

    const written = mockWriteSync.mock.calls[0]![1] as string;
    const entry = JSON.parse(written.trimEnd());

    expect(entry.message).toBe("42");
    expect(entry.stack).toBeUndefined();
    expect(entry.error_code).toBe("unhandled_rejection");
  });

  it("handleUnhandledRejection handles non-stringifiable values", () => {
    const obj = Object.create(null);
    obj.toString = () => {
      throw new Error("toString threw");
    };

    handleUnhandledRejection(obj);

    const written = mockWriteSync.mock.calls[0]![1] as string;
    const entry = JSON.parse(written.trimEnd());

    expect(entry.message).toBe("[non-stringifiable value]");
    expect(entry.stack).toBeUndefined();
    expect(entry.error_code).toBe("unhandled_rejection");
  });
});
