/**
 * In-memory Claude Code session store for session continuity.
 *
 * Maps thread IDs to CC session IDs so that thread replies can resume
 * the existing Claude Code session. v1 uses an in-memory Map —
 * Redis is a future enhancement.
 */

/** Maps thread ID → Claude Code session ID. */
export type CcSessionStore = Map<string, string>;

/** Create a new in-memory CC session store. */
export function createCcSessionStore(): CcSessionStore {
  return new Map();
}

/**
 * Look up the CC session ID for a given thread.
 * Returns `undefined` if no session exists (i.e., new conversation).
 */
export function getCcSessionId(
  store: CcSessionStore,
  threadId: string,
): string | undefined {
  return store.get(threadId);
}

/**
 * Store the CC session ID for a given thread.
 * Overwrites any previously stored session ID for the same thread.
 */
export function setCcSessionId(
  store: CcSessionStore,
  threadId: string,
  sessionId: string,
): void {
  store.set(threadId, sessionId);
}
