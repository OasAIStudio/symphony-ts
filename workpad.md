## Workpad
**Environment**: pro14:/Users/ericlitman/intent/workspaces/architecture-build/repo/symphony-ts@73532bb

### Plan

- [x] Add `analyze` subcommand to `ops/symphony-ctl`
  - [x] Accept optional JSONL path (default: most recent `/tmp/symphony-logs-*/symphony.jsonl`)
  - [x] Parse `stage_completed` events for per-issue/per-stage summaries
  - [x] Parse `turn_completed` events for per-turn granularity
  - [x] Output formatted text report: run summary, per-issue table, per-stage averages, cache efficiency, outliers
  - [x] Support `--json` flag for machine-readable output
  - [x] Handle missing fields gracefully (older logs)
  - [x] Use only standard unix tools (jq, awk, sort) — no extra dependencies

### Acceptance Criteria

- [x] `symphony-ctl analyze <path>` prints a formatted text report
- [x] `symphony-ctl analyze --json <path>` outputs machine-readable JSON
- [x] Default path uses most recent `/tmp/symphony-logs-*/symphony.jsonl`
- [x] Missing fields produce zero/unknown gracefully
- [x] No new npm dependencies added
- [x] Full test suite: 435 passed, 3 skipped, 0 failed

### Validation
- Bash syntax check passed: `bash -n ops/symphony-ctl`
- Text output verified with 4-stage test log including outliers
- Empty/missing-field logs handled gracefully
- Default path detection picks most recently modified log
- TypeScript: `npx tsc --noEmit` → exit 0
- Tests: `pnpm test` → 435 passed, 3 skipped, 0 failed

### Notes
- 2026-03-21 SYMPH-28 implementation complete. PR opened.
