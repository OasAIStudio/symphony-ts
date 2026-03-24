/**
 * Reaction lifecycle helpers for Slack message processing.
 *
 * Manages the emoji reaction indicators that show message processing state:
 * - eyes: processing in progress
 * - white_check_mark: completed successfully
 * - x: completed with error
 * - warning: configuration issue (e.g., unmapped channel)
 */
import type { webApi } from "@slack/bolt";

/** Mark a message as being processed (add eyes reaction). */
export async function markProcessing(
  client: webApi.WebClient,
  channel: string,
  timestamp: string,
): Promise<void> {
  await client.reactions.add({ channel, timestamp, name: "eyes" });
}

/** Mark a message as successfully completed (replace eyes with checkmark). */
export async function markSuccess(
  client: webApi.WebClient,
  channel: string,
  timestamp: string,
): Promise<void> {
  await client.reactions.remove({ channel, timestamp, name: "eyes" });
  await client.reactions.add({ channel, timestamp, name: "white_check_mark" });
}

/** Mark a message as failed (replace eyes with x). */
export async function markError(
  client: webApi.WebClient,
  channel: string,
  timestamp: string,
): Promise<void> {
  await client.reactions.remove({ channel, timestamp, name: "eyes" });
  await client.reactions.add({ channel, timestamp, name: "x" });
}

/** Mark a message as having a configuration warning (replace eyes with warning). */
export async function markWarning(
  client: webApi.WebClient,
  channel: string,
  timestamp: string,
): Promise<void> {
  await client.reactions.remove({ channel, timestamp, name: "eyes" });
  await client.reactions.add({ channel, timestamp, name: "warning" });
}
