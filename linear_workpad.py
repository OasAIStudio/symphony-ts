#!/usr/bin/env python3
import urllib.request
import urllib.error
import json
import sys

LINEAR_API_KEY = "lin_api_918XV2C6hRqc4U4lIohtEJCs2NJYyHqhVBaXMFav"
ISSUE_ID = "7b4cc9a1-e014-4463-8cab-78bce7cfa7d0"

WORKPAD_CONTENT = r"""## Workpad
**Environment**: pro14:/Users/ericlitman/intent/workspaces/architecture-build/repo/symphony-ts@8d4e5b7

### Plan
- [ ] **Step 1: Add `poll_tick_completed` to `ORCHESTRATOR_EVENTS` in `src/domain/model.ts`**
  - Insert `"poll_tick_completed"` into the array after `"poll_tick"`

- [ ] **Step 2: Add new log fields to `LOG_FIELDS` in `src/logging/fields.ts`**
  - Add `"dispatched_count"`, `"running_count"`, `"reconciled_stop_requests"` to the `LOG_FIELDS` array

- [ ] **Step 3: Extend `PollTickResult` in `src/orchestrator/core.ts` to include `runningCount`**
  - `PollTickResult` already has `dispatchedIssueIds: string[]` and `stopRequests: StopRequest[]`
  - Add `runningCount: number` field
  - In all three return sites of `pollTick()`, set `runningCount: Object.keys(this.state.running).length`
  - Note: `stopRequests` already provides reconciliation stop count, `dispatchedIssueIds.length` provides dispatch count

- [ ] **Step 4: Add timing in `runPollCycle()` in `src/orchestrator/runtime-host.ts`**
  - Before `runtimeHost.pollOnce()`, record `const tickStart = Date.now()`
  - After `pollOnce()` returns, compute `durationMs = Date.now() - tickStart`
  - Pass `durationMs` to `logPollCycleResult(logger, result, durationMs)`

- [ ] **Step 5: Update `logPollCycleResult()` signature and body in `src/orchestrator/runtime-host.ts`**
  - Add `durationMs: number` parameter
  - After the existing warn/error checks, emit an info-level `poll_tick_completed` event:
    ```typescript
    await logger.info("poll_tick_completed", "Poll tick completed.", {
      dispatched_count: result.dispatchedIssueIds.length,
      running_count: result.runningCount,
      reconciled_stop_requests: result.stopRequests.length,
      duration_ms: durationMs,
    });
    ```

- [ ] **Step 6: Add tests in `tests/orchestrator/runtime-host.test.ts`**
  - New describe block for poll tick logging
  - Test 1: `poll_tick_completed` event is logged after a successful poll (using `startRuntimeService`)
  - Test 2: `dispatched_count` reflects the number of newly dispatched issues
  - Verify `running_count` and `reconciled_stop_requests` fields are present and numeric

### Acceptance Criteria
- [ ] `poll_tick_completed` in `ORCHESTRATOR_EVENTS`
- [ ] `dispatched_count`, `running_count`, `reconciled_stop_requests` in `LOG_FIELDS`
- [ ] `PollTickResult` has `runningCount: number` and all return sites populate it
- [ ] `logPollCycleResult` emits `poll_tick_completed` info event with all four fields
- [ ] `runPollCycle` times the `pollOnce()` call and passes duration
- [ ] Test: `poll_tick_completed` event is logged after successful poll
- [ ] Test: `dispatched_count` reflects newly dispatched issues
- [ ] All existing tests pass
- [ ] `npx tsc --noEmit` passes

### Validation
- `pnpm test`
- `npx tsc --noEmit`
- `pnpm lint`

### Notes
- 2026-03-20 Investigation complete. Plan posted.
- `PollTickResult.dispatchedIssueIds` is already `string[]` — use `.length` for `dispatched_count`
- `PollTickResult.stopRequests` is already `StopRequest[]` — use `.length` for `reconciled_stop_requests`
- `runningCount` must be added to `PollTickResult`; it is computed as `Object.keys(this.state.running).length` at the end of `pollTick()` in `core.ts`
- The `logPollCycleResult` function currently takes `(logger, result)` and uses `Awaited<ReturnType<OrchestratorRuntimeHost["pollOnce"]>>` as the result type — need to add `durationMs: number` parameter
- `duration_ms` already exists in `LOG_FIELDS`, so no new field needed for it
- The three early-return paths in `pollTick()` must all include `runningCount`
"""

def graphql(query, variables=None):
    payload = json.dumps({"query": query, "variables": variables or {}}).encode("utf-8")
    req = urllib.request.Request(
        "https://api.linear.app/graphql",
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": LINEAR_API_KEY,
        },
        method="POST",
    )
    with urllib.request.urlopen(req) as resp:
        return json.loads(resp.read())

# Step 1: Query existing comments
result = graphql("""
query GetComments($issueId: String!) {
  issue(id: $issueId) {
    comments {
      nodes {
        id
        body
      }
    }
  }
}
""", {"issueId": ISSUE_ID})

print("Query result:", json.dumps(result, indent=2))

comments = result.get("data", {}).get("issue", {}).get("comments", {}).get("nodes", [])
existing = next((c for c in comments if "## Workpad" in c["body"]), None)

if existing:
    print(f"\nFound existing workpad comment: {existing['id']}")
    update_result = graphql("""
mutation UpdateComment($id: String!, $body: String!) {
  commentUpdate(id: $id, input: { body: $body }) {
    success
    comment {
      id
    }
  }
}
""", {"id": existing["id"], "body": WORKPAD_CONTENT})
    print("Update result:", json.dumps(update_result, indent=2))
    print(f"\nACTION: updated")
    print(f"COMMENT_ID: {existing['id']}")
else:
    print("\nNo existing workpad comment found, creating new one...")
    create_result = graphql("""
mutation CreateComment($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) {
    success
    comment {
      id
    }
  }
}
""", {"issueId": ISSUE_ID, "body": WORKPAD_CONTENT})
    print("Create result:", json.dumps(create_result, indent=2))
    new_id = create_result.get("data", {}).get("commentCreate", {}).get("comment", {}).get("id")
    print(f"\nACTION: created")
    print(f"COMMENT_ID: {new_id}")
