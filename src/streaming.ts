/**
 * Streaming utilities for collecting AI SDK stream responses.
 *
 * Provides helpers to consume an async text stream from the Vercel AI SDK
 * `streamText()` result and collect the full response text.
 */

/**
 * Collect all chunks from an async text stream into a single string.
 *
 * @param textStream - The async iterable text stream from `streamText().textStream`.
 * @returns The concatenated full response text.
 */
export async function collectStream(
  textStream: AsyncIterable<string>,
): Promise<string> {
  let fullText = "";
  for await (const chunk of textStream) {
    fullText += chunk;
  }
  return fullText;
}
