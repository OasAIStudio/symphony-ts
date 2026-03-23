/**
 * Message chunking utilities for Slack message posting.
 *
 * Slack imposes a ~40,000 character limit per message. This module splits
 * long responses at paragraph boundaries, falling back to hard splits when
 * a single paragraph exceeds the limit.
 */

/** Maximum characters per Slack message chunk. */
export const SLACK_MAX_CHARS = 39_000;

/**
 * Split a response into chunks that each fit within Slack's message limit.
 *
 * Strategy:
 * 1. Split text at paragraph boundaries (`\n\n`).
 * 2. Accumulate paragraphs into chunks up to `maxChars`.
 * 3. If a single paragraph exceeds `maxChars`, hard-split it.
 *
 * @param text - The full response text to chunk.
 * @param maxChars - Maximum characters per chunk (default: 39,000).
 * @returns Array of string chunks, each under `maxChars`.
 */
export function chunkResponse(
  text: string,
  maxChars: number = SLACK_MAX_CHARS,
): string[] {
  if (text.length <= maxChars) {
    return [text];
  }

  const paragraphs = text.split(/\n\n+/);
  const chunks: string[] = [];
  let current = "";

  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();
    if (trimmed.length === 0) {
      continue;
    }

    // If a single paragraph exceeds maxChars, hard-split it
    if (trimmed.length > maxChars) {
      // Flush current buffer first
      if (current.length > 0) {
        chunks.push(current);
        current = "";
      }
      // Hard-split the oversized paragraph
      for (let i = 0; i < trimmed.length; i += maxChars) {
        chunks.push(trimmed.slice(i, i + maxChars));
      }
      continue;
    }

    // Would adding this paragraph exceed the limit?
    const separator = current.length > 0 ? "\n\n" : "";
    if (current.length + separator.length + trimmed.length > maxChars) {
      // Flush current chunk and start a new one
      if (current.length > 0) {
        chunks.push(current);
      }
      current = trimmed;
    } else {
      current = current + separator + trimmed;
    }
  }

  // Flush remaining content
  if (current.length > 0) {
    chunks.push(current);
  }

  return chunks.length > 0 ? chunks : [text];
}
