## Workpad
**Environment**: pro14:/Users/ericlitman/intent/workspaces/architecture-build/repo/symphony-ts@2ad9b61

### Plan

- [ ] Add `formatReviewFindingsComment(issueIdentifier: string, stageName: string, agentMessage: string): string` to `src/orchestrator/gate-handler.ts`
  - Export alongside existing `formatGateComment`
  - Returns markdown: `## Review Findings\n\n**Issue:** {issueIdentifier}\n**Stage:** {stageName}\n**Failure class:** review\n\n{agentMessage}`
- [ ] Update `src/orchestrator/core.ts`:
  - Import `formatReviewFindingsComment` from `./gate-handler.js`
  - Update `postReviewFindingsComment` to use `formatReviewFindingsComment(issueIdentifier, stageName, agentMessage)` instead of inline string construction
  - Thread `issueIdentifier` (from `runningEntry.identifier`) and `stageName` (current stage name) through call sites
- [ ] Add 5 missing test cases to `tests/orchestrator/core.test.ts`:
  - `"review findings comment failure does not block rework"` — postComment throws, rework still proceeds
  - `"postComment error is swallowed for review findings"` — no error propagated to caller
  - `"skips review findings when postComment not configured"` — no postComment configured, rework proceeds silently
  - `"escalation fires on max rework exceeded"` — maxRework hit → escalation comment+state fires
  - `"no review findings on escalation"` — when escalated, review findings comment NOT posted
- [ ] Optionally add unit tests for `formatReviewFindingsComment` to `tests/orchestrator/gate-handler.test.ts`

### Acceptance Criteria

- [ ] `formatReviewFindingsComment` exported from `gate-handler.ts`, follows `formatGateComment` markdown style
- [ ] `postReviewFindingsComment` in `core.ts` uses `formatReviewFindingsComment` (no inline body construction)
- [ ] `void ... .catch()` pattern used for best-effort posting
- [ ] Review findings posted ONLY when rework proceeds (not on escalation)
- [ ] All 5 new test cases pass with exact names from spec
- [ ] All 362 existing tests continue to pass

### Validation
- `npm test -- --grep "posts review findings comment on agent review failure"`
- `npm test -- --grep "review findings comment includes agent message"`
- `npm test -- --grep "review failure triggers rework after posting comment"`
- `npm test -- --grep "review findings comment failure does not block rework"`
- `npm test -- --grep "postComment error is swallowed for review findings"`
- `npm test -- --grep "skips review findings when postComment not configured"`
- `npm test -- --grep "escalation fires on max rework exceeded"`
- `npm test -- --grep "no review findings on escalation"`
- `npm test` (full suite — all 362+ tests pass)

### Notes
- 2026-03-21 SYMPH-13 investigation complete. Plan posted.
- Current state: `postReviewFindingsComment` exists in core.ts (lines 696–714) — constructs body inline. Three of eight spec tests already pass. `formatReviewFindingsComment` NOT yet in gate-handler.ts — primary gap.
- `issueExecutionHistory` cleanup already present in all escalation/terminal paths (from SYMPH-12) — no changes needed there.
- The "before calling reworkGate()" phrasing reconciles with "no review findings on escalation" by calling `reworkGate` first, posting findings only when NOT escalated — current behavior is correct.
- No new dependencies needed.
