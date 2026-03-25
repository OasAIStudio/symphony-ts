import { describe, expect, it } from "vitest";

import { TEST_ALPHA_READY, greet } from "../src/test-alpha.js";

describe("test-alpha", () => {
  it("module is ready", () => {
    expect(TEST_ALPHA_READY).toBe(true);
  });

  it("greet returns expected string", () => {
    expect(greet("Symphony")).toBe("Hello, Symphony!");
  });
});
