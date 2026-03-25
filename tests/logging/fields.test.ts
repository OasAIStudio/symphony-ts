import { describe, expect, it } from "vitest";

import {
  LOG_FIELDS,
  REQUIRED_LOG_CONTEXT_FIELDS,
} from "../../src/logging/fields.js";

describe("LOG_FIELDS", () => {
  it("contains the core structured log context required for conformance", () => {
    expect(REQUIRED_LOG_CONTEXT_FIELDS).toEqual([
      "issue_id",
      "issue_identifier",
      "session_id",
    ]);
  });

  it("tracks token and rate limit telemetry fields", () => {
    expect(LOG_FIELDS).toContain("input_tokens");
    expect(LOG_FIELDS).toContain("output_tokens");
    expect(LOG_FIELDS).toContain("total_tokens");
    expect(LOG_FIELDS).toContain("rate_limit_requests_remaining");
    expect(LOG_FIELDS).toContain("rate_limit_tokens_remaining");
  });

  it("includes per-turn observability fields", () => {
    expect(LOG_FIELDS).toContain("turn_number");
    expect(LOG_FIELDS).toContain("prompt_chars");
    expect(LOG_FIELDS).toContain("estimated_prompt_tokens");
  });
});
