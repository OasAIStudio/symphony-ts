import { describe, expect, it } from "vitest";

import { SLACK_MAX_CHARS, chunkResponse } from "../src/chunking.js";

describe("chunkResponse", () => {
  it("returns a single chunk for text under the limit", () => {
    const text = "Short response";
    const chunks = chunkResponse(text);
    expect(chunks).toEqual(["Short response"]);
  });

  it("splits an 80K char response into 3 messages, each under 39K chars", () => {
    // Build an 80,000 char response from paragraphs, each ~1,000 chars
    const paragraphSize = 1000;
    const paragraphCount = 80;
    const paragraphs: string[] = [];
    for (let i = 0; i < paragraphCount; i++) {
      paragraphs.push(
        `Paragraph ${i + 1}: ${"x".repeat(paragraphSize - `Paragraph ${i + 1}: `.length)}`,
      );
    }
    const fullText = paragraphs.join("\n\n");
    expect(fullText.length).toBeGreaterThanOrEqual(80_000);

    const chunks = chunkResponse(fullText);

    // Each chunk must be under 39K chars
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(SLACK_MAX_CHARS);
    }

    // 80K split into 39K chunks → expect 3 chunks
    expect(chunks).toHaveLength(3);
  });

  it("splits at paragraph boundaries when possible", () => {
    // Create two paragraphs that together exceed the limit
    const halfLimit = Math.floor(SLACK_MAX_CHARS / 2);
    const paragraph1 = "A".repeat(halfLimit);
    const paragraph2 = "B".repeat(halfLimit);
    const paragraph3 = "C".repeat(halfLimit);
    const text = `${paragraph1}\n\n${paragraph2}\n\n${paragraph3}`;

    const chunks = chunkResponse(text);

    // Should split at paragraph boundaries, not mid-text
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(SLACK_MAX_CHARS);
    }

    // Verify content is preserved (join with paragraph separator)
    const rejoined = chunks.join("\n\n");
    expect(rejoined).toBe(text);
  });

  it("hard-splits a single paragraph exceeding the limit", () => {
    const oversizedParagraph = "Z".repeat(SLACK_MAX_CHARS + 5000);
    const chunks = chunkResponse(oversizedParagraph);

    expect(chunks.length).toBe(2);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(SLACK_MAX_CHARS);
    }

    // Content is preserved
    expect(chunks.join("")).toBe(oversizedParagraph);
  });

  it("posts all chunks to the same thread (all chunks returned in order)", () => {
    // This tests that chunkResponse returns an ordered array
    // The caller (handler) posts each chunk to thread.post() sequentially
    const paragraphs: string[] = [];
    for (let i = 0; i < 50; i++) {
      paragraphs.push(`Section ${i + 1}: ${"x".repeat(1400)}`);
    }
    const text = paragraphs.join("\n\n");

    const chunks = chunkResponse(text);

    // Verify ordering: reassembling chunks should give back the original text
    const reassembled = chunks.join("\n\n");
    expect(reassembled).toBe(text);

    // All chunks should be under the limit
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(SLACK_MAX_CHARS);
    }

    // Multiple chunks required for this large text
    expect(chunks.length).toBeGreaterThan(1);
  });

  it("handles text with only whitespace paragraphs", () => {
    const text = "Hello\n\n   \n\n\n\nWorld";
    const chunks = chunkResponse(text);
    // Should filter empty paragraphs but since total is small, single chunk
    expect(chunks).toHaveLength(1);
  });

  it("uses custom maxChars when provided", () => {
    const text = `${"A".repeat(100)}\n\n${"B".repeat(100)}`;
    const chunks = chunkResponse(text, 150);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe("A".repeat(100));
    expect(chunks[1]).toBe("B".repeat(100));
  });
});
