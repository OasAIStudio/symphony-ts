# Investigation Brief
## Issue: SYMPH-57 — Consolidate spec-gen to produce 1-2 sub-issues for STANDARD specs

## Objective
Update three spec-gen skill reference files to change the STANDARD tier task-count target from "2-6" to "1-2". Pipeline telemetry shows ~20 min fixed overhead per ticket regardless of complexity, so fewer larger tickets dramatically reduce total wall-clock time. No logic changes — only documentation/guidance text updates.

## Relevant Files (ranked by importance)

1. `~/.claude/skills/spec-gen/references/complexity-router.md` — Primary file. Contains the STANDARD tier definition, the decision tree, Rule 6 (task-count estimate guidance), and the Quick Reference Table. Four distinct locations need updating.
2. `~/.claude/skills/spec-gen/references/model-tendencies.md` — Contains "Task granularity mismatch" bullet and Spec Quality Checklist. Two locations need updating.
3. `~/.claude/skills/spec-gen/SKILL.md` — Step 4 Self-Review checklist references `2-6 for STANDARD`. One location needs updating.

## Key Code Patterns

- All files are plain Markdown — no code, no tests, no build step.
- Changes are simple string substitutions: `2-6` → `1-2` in STANDARD-context sentences.
- Be precise: the string `2-6` also appears in non-STANDARD contexts (e.g., "Touches 2-6 files" in the STANDARD Signals list) — do NOT change those.

## Architecture Context

These files are read by the `spec-gen` skill (a Claude slash command at `~/.claude/skills/spec-gen/SKILL.md`) during spec generation. They are guidance documents, not executable code. No tests, no imports, no CI pipeline applies to them directly.

## Exact Changes Required

### File 1: `~/.claude/skills/spec-gen/references/complexity-router.md`

**Change 1 — Decision tree (line 13):**
```
Before: │   ├── 1 capability, ≤6 tasks, clear scope → STANDARD
After:  │   ├── 1 capability, ≤2 tasks, clear scope → STANDARD
```

**Change 2 — STANDARD definition (line 60):**
```
Before: **Definition**: A single capability with clear scope that decomposes into 2-6 tasks.
After:  **Definition**: A single capability with clear scope that decomposes into 1-2 tasks.
```

**Change 3 — Quick Reference Table (line 167):**
```
Before: | Tasks | 0-1 | 2-6 | 7+ |
After:  | Tasks | 0-1 | 1-2 | 7+ |
```

**Change 4 — Rule 6, Signal Detection (line 142):**
```
Before: If you estimate 2-6 tasks → STANDARD. If you estimate 7+ tasks → COMPLEX. If you estimate 1 task → TRIVIAL (unless it's a behavioral change with verification needs).
After:  If you estimate 1-2 tasks → STANDARD. If you estimate 3+ tasks → COMPLEX. If you estimate 1 task → TRIVIAL (unless it's a behavioral change with verification needs).
```
Note: Rule 6 also updates the COMPLEX boundary from "7+" to "3+" to eliminate the 3-6 gap — this is consistent with the new 1-2 STANDARD definition and the "3+ capabilities → COMPLEX" spirit of the spec. If the issue intent is strictly "only change STANDARD, don't touch COMPLEX threshold," keep `7+` and add a TODO noting the gap.

### File 2: `~/.claude/skills/spec-gen/references/model-tendencies.md`

**Change 1 — Task granularity mismatch bullet (line 25):**
```
Before: Target 2-6 tasks for STANDARD features.
After:  Target 1-2 tasks for STANDARD features.
```

**Change 2 — Spec Quality Checklist (line 76):**
```
Before: - [ ] Task count is appropriate for complexity tier (2-6 for STANDARD)
After:  - [ ] Task count is appropriate for complexity tier (1-2 for STANDARD)
```

### File 3: `~/.claude/skills/spec-gen/SKILL.md`

**Change 1 — Step 4 Self-Review checklist (line 288):**
```
Before: - [ ] Task count matches complexity tier (2-6 for STANDARD, 7+ for COMPLEX)
After:  - [ ] Task count matches complexity tier (1-2 for STANDARD, 7+ for COMPLEX)
```

## Test Strategy

No automated tests. Validate with grep:
```bash
# Confirm no STANDARD-context "2-6" references remain:
grep -n "2-6" ~/.claude/skills/spec-gen/references/complexity-router.md
grep -n "2-6" ~/.claude/skills/spec-gen/references/model-tendencies.md
grep -n "2-6" ~/.claude/skills/spec-gen/SKILL.md

# Confirm new "1-2" values are present in each file:
grep -n "1-2" ~/.claude/skills/spec-gen/references/complexity-router.md
grep -n "1-2" ~/.claude/skills/spec-gen/references/model-tendencies.md
grep -n "1-2" ~/.claude/skills/spec-gen/SKILL.md
```

Note: `complexity-router.md` has `2-6` in the STANDARD Signals list ("Touches 2-6 files") — this is a *file count* signal, NOT a task count. Do NOT change it.

## Gotchas & Constraints

- **Only change task-count references to "2-6"**, not file-count references. "Touches 2-6 files" in the STANDARD Signals section stays unchanged.
- **STANDARD examples table** (complexity-router.md lines 78-86) shows 2-4 estimated tasks per example. These are now inconsistent with the new 1-2 target but the issue spec does not mention updating them. Leave them as-is; optionally add a `<!-- TODO: update examples to reflect 1-2 task target -->` HTML comment.
- **Do not change COMPLEX threshold** in the Quick Reference Table unless the spec explicitly says to. The issue is ambiguous on Rule 6 — see Change 4 notes above.
- These files live in `~/.claude/skills/`, NOT in the symphony-ts repo. No PR is needed. Changes are applied directly.
- No build step, no tests, no migration.

## Key Code Excerpts

**complexity-router.md lines 12-14 (decision tree):**
```
│   ├── How many capabilities does it touch?
│   │   ├── 1 capability, ≤6 tasks, clear scope → STANDARD      ← change ≤6 to ≤2
│   │   └── 2+ capabilities, OR architectural change, OR 7+ tasks → COMPLEX
```

**complexity-router.md lines 59-60 (STANDARD definition):**
```
### STANDARD — Generate spec → parent issue in Draft → freeze to sub-issues

**Definition**: A single capability with clear scope that decomposes into 2-6 tasks.   ← change to 1-2
```

**model-tendencies.md lines 24-26 (granularity mismatch):**
```
- **Task granularity mismatch**: Either decomposes into too many tiny tasks (1 task per endpoint) or too few large tasks (1 task for entire feature). Target 2-6 tasks for STANDARD features.   ← change to 1-2
```
