---
name: spec-gen
description: Generate structured specs from brain dumps. Explores target codebase in plan mode, classifies complexity (trivial/standard/complex), generates specs with Gherkin scenarios and executable verify lines, syncs to Linear as parent issue in Draft state for review.
argument-hint: <brain dump description of what to build>
---

# Spec Generator — Brain Dump to Linear Spec

You transform unstructured brain dumps into structured, verifiable specifications stored in Linear. Specs live in Linear, not the repo (Decision 32). Iteration happens through chat replies with one-way sync to Linear (Decision 33).

## Skill Contents

This skill uses progressive disclosure. Read reference files **when indicated**, not upfront.

| File | Contents | When to Read |
|------|----------|-------------|
| `references/exploration-checklist.md` | Targeted codebase discovery patterns and scoping rules | **Step 0** — before exploring the codebase |
| `references/complexity-router.md` | Decision tree for trivial/standard/complex classification | **Step 1** — before generating anything |
| `references/verify-line-guide.md` | How to write executable `# Verify:` lines with worked examples | **Step 3** — when writing Gherkin scenarios |
| `references/model-tendencies.md` | Known spec generation artifacts and self-correction checklist | **Step 4** — before finalizing |

All paths are relative to `~/.claude/skills/spec-gen/`.

---

## Inputs

The skill accepts one of:
1. **A brain dump** — unstructured text describing what to build
2. **A Linear Idea issue** — an existing issue in `Idea` state (provide the issue identifier, e.g., `SYMPH-42`). The skill reads the issue description as the brain dump and upgrades it to `Draft`.

### Product Context

The skill reads Linear config from a WORKFLOW file. The user can provide either:
1. **A WORKFLOW file path** (explicit path to a `.md` file) — used directly, no resolution needed. For ad-hoc projects without a named product entry.
2. **A product name** (e.g., `SYMPH`, `JONY`) — resolves to `<repo_path>/pipeline-config/workflows/WORKFLOW-<product>.md`

```bash
# Named product example: product "symphony" →
#   <repo_path>/pipeline-config/workflows/WORKFLOW-symphony.md
#
# WORKFLOW file contains:
#   tracker:
#     project_slug: fdba14472043   ← Linear project UUID
#
# Auth: linear handles auth via LINEAR_API_KEY env var or `linear auth login`.
```

**Resolution order:**
1. If the user provides a WORKFLOW file path (an explicit path ending in `.md`) → use it directly
2. If the user provides a product name → resolve to `<repo_path>/pipeline-config/workflows/WORKFLOW-<product>.md`
3. If neither → ask: "Which product is this for, or provide a path to the WORKFLOW file?"

### Repo Path

The skill needs the local filesystem path to the target repository for codebase exploration (file reads, greps, globs) and to locate WORKFLOW files.

**Resolution order:**
1. **Explicit in brain dump** — if the user includes a path (e.g., "Repo: ~/projects/my-app"), use it
2. **Current working directory** — if cwd contains project markers (`package.json`, `Cargo.toml`, `go.mod`, `pyproject.toml`, `.git`, etc.), use cwd
3. **Ask** — if neither, ask: "What's the local path to the repo?"

All codebase exploration should be scoped to this path. Named-product WORKFLOW files are at `<repo_path>/pipeline-config/workflows/WORKFLOW-<product>.md`.

---

## Step 0: Explore Target Codebase

**Read `references/exploration-checklist.md` now.** This step grounds the spec in actual code reality before any classification or generation happens.

**Skip this step if:** there is no target repo (greenfield project with no existing code), or the user explicitly says "skip exploration."

### Enter Plan Mode

Call `EnterPlanMode` to enter read-only exploration mode. In plan mode you can only read, search, and explore — no file writes, no issue creation.

### Targeted Exploration

Use the brain dump keywords to guide a focused exploration of the target codebase. Do NOT audit the entire codebase. Focus on what the brain dump touches.

**Exploration checklist** (see `references/exploration-checklist.md` for full details with examples):

1. **Project structure**: Package manager, framework, entry points, directory layout
2. **Relevant modules**: Files and directories the brain dump would touch
3. **Existing patterns**: How similar features are currently implemented (find the closest analog)
4. **Test infrastructure**: Test runner, test directory structure, fixture patterns
5. **Schema/data model**: Database schema, API types, or data structures the change would affect
6. **Dependencies**: External libraries or services involved in the affected area
7. **Prior art**: Has anything similar been attempted before? (check git log)

### Produce the Codebase Context Report

Assemble findings into a structured summary. This report is internal working context — it is NOT included in the Linear issue. It informs all subsequent steps.

```
## Codebase Context Report

### Project Overview
- **Stack**: <language, framework, runtime>
- **Package manager**: <e.g., bun, npm, pnpm>
- **Test runner**: <e.g., "bun test", "jest", "pytest">
- **Entry point**: <main application entry>

### Affected Area
- **Files likely touched**: <list of specific file paths>
- **Modules/directories**: <which top-level modules are affected>
- **Estimated file count**: <N files> across <M modules>

### Existing Patterns
- **Closest analog**: <most similar existing feature and where it lives>
- **Pattern to follow**: <how is it structured — route → handler → service → repo, etc.>
- **Conventions**: <naming, error handling, response shapes observed>

### Test Landscape
- **Test location**: <e.g., "tests/ directory, colocated *.test.ts files">
- **Test patterns**: <unit, integration, e2e>
- **Fixture approach**: <how test data is set up>
- **Verify line hints**: <what commands work for this project's test runner>

### Data Model
- **Relevant schema**: <tables, types, or interfaces affected>
- **Migrations**: <does the project use migrations? where?>

### Risks and Constraints
- <anything discovered that affects scope, approach, or complexity>

### Classification Signal
- Estimated files touched: <N>
- Estimated capabilities: <N>
- Cross-cutting concerns: <yes/no — describe if yes>
- Infrastructure changes needed: <yes/no — describe if yes>
- Unknowns discovered: <count and list>
```

### Exit Plan Mode

Call `ExitPlanMode` to present the Codebase Context Report to the user. Wait for approval before proceeding to Step 1.

If the user requests additional exploration or corrections, re-enter plan mode, update the report, and re-present.

---

## Step 1: Classify Complexity

**Read `references/complexity-router.md` now.** Classification happens BEFORE any spec content is generated.

If Step 0 ran, use the **Classification Signal** section from the Codebase Context Report to inform classification. The report provides concrete file counts, capability counts, cross-cutting analysis, and unknown counts — use these instead of estimating from the brain dump alone.

Analyze the brain dump and classify as one of:

| Tier | Action |
|------|--------|
| **TRIVIAL** | Skip spec. Create a single Linear issue directly in `Todo` state using `freeze-and-queue.sh --trivial "Title" <workflow-path>`. Pipe a description to stdin if needed. No parent issue, no sub-issues, no Gherkin. Done. |
| **STANDARD** | Generate full spec → create parent issue in `Draft` state (Steps 2-5). |
| **COMPLEX** | Generate full spec (Steps 2-5). Flag for ensemble review before freezing. |

**State your classification and reasoning before proceeding.** Examples:

> **Classification: TRIVIAL**
> Rationale: Single-file bug fix with known root cause and known fix. No design ambiguity.

```bash
# Create trivial issue directly in Todo:
bash ~/.claude/skills/spec-gen/scripts/freeze-and-queue.sh \
  --trivial "Fix DELETE /api/tasks 500 on non-numeric ID" <workflow-path>

# With a description piped in:
echo "Return 400 instead of 500 when id param is non-numeric" | \
  bash ~/.claude/skills/spec-gen/scripts/freeze-and-queue.sh \
  --trivial "Fix DELETE /api/tasks 500 on non-numeric ID" <workflow-path>
```

> **Classification: STANDARD**
> Rationale: Single capability (pagination), clear scope (3 endpoints affected), no architectural decisions needed. Estimated 3 tasks.

### Idea Issue Upgrade

If the input is an existing `Idea` issue:
1. Read the issue description from Linear
2. Use it as the brain dump for classification
3. On spec creation, update the existing issue (move to `Draft`) rather than creating a new one

---

## Step 2: Generate Spec Content

If Step 0 ran, use the Codebase Context Report to write accurate file paths in Task Scope fields, follow the structure described in Existing Patterns, reference the correct framework and runtime in verify lines, and set accurate Out of Scope boundaries based on what the codebase actually contains.

Generate the spec as a single markdown document. This will become the Linear parent issue description.

```markdown
# <Feature Name>

## Problem
<What's missing or broken — from the user's perspective>

## Solution
<What we're building — 2-3 sentences max>

## Scope
### In Scope
- <Specific deliverables>

### Out of Scope
- <What this does NOT include>

## Acceptance Criteria
- AC1: <specific, testable criterion>
- AC2: <specific, testable criterion>

## Scenarios

### Feature: <Feature Name>

\`\`\`gherkin
Scenario: <Descriptive name>
    Given <precondition>
    When I <action>
    Then <expected outcome>
    # Verify: <executable shell command, exit 0 = pass>
    And <additional outcome>
    # Verify: <executable shell command>
\`\`\`

## Boundaries
### Always
- <Guardrails the implementing agent must follow>

### Never
- <Hard stops — things the agent must not do>

## Tasks

### Task 1: <Title>
**Priority**: <1-3, lower = more urgent>
**Scope**: <comma-separated file paths>
**Scenarios**: <which scenarios this task covers>

### Task 2: ...
```

Keep proposals and tasks in a single document — they share context in the Linear issue description.

---

## Step 3: Write Verify Lines

**Read `references/verify-line-guide.md` now.**

If Step 0 ran, use the **Test Landscape** section from the Codebase Context Report to use the correct test runner command (e.g., `bun test` vs `npx jest` vs `pytest`), follow the project's test file naming convention for `# Test:` directives, and match fixture patterns observed in existing tests.

### Verify Line Rules (MANDATORY)

- Every THEN and AND clause **MUST** have a `# Verify:` line immediately after it.
- Verify lines are shell commands. Exit 0 = pass, non-zero = fail.
- Use `$BASE_URL` for HTTP targets, never hardcoded localhost.
- Each verify line must be self-contained — no dependency on previous verify lines.
- Use `curl -sf` for success cases, `curl -s` for error cases (checking status codes).
- Use `jq -e` (not `jq`) to get non-zero exit on false.

### Test Directives (OPTIONAL)

`# Test:` directives tell the implementing agent to generate a persistent test file. Use when:
- Internal logic can't be verified through external behavior alone
- Edge cases need programmatic test coverage beyond verify lines
- You want tests that persist in the repo for CI

```gherkin
Then the cache is invalidated after update
# Verify: bun test tests/cache.test.ts
# Test: Unit test that cache TTL resets when a task is updated
```

---

## Step 4: Self-Review

**Read `references/model-tendencies.md` now.**

Before presenting the spec to the user, check:

- [ ] Every THEN/AND has a `# Verify:` line
- [ ] All verify lines use `$BASE_URL`
- [ ] No `$BASE_URL` in assertion values
- [ ] `jq -e` used (not bare `jq`)
- [ ] Error cases use `-s` not `-sf`
- [ ] Acceptance criteria are specific (no "should handle gracefully")
- [ ] Task count matches complexity tier (1-2 for STANDARD, 7+ for COMPLEX)
- [ ] No scope creep beyond the brain dump
- [ ] File paths in Task Scope match actual files discovered in Step 0 (no invented paths)
- [ ] Verify line commands use the project's actual test runner and patterns
- [ ] Spec structure follows existing patterns identified in Step 0 (not a novel architecture)

If any check fails, fix the spec before presenting it.

---

## Step 5: Sync to Linear (Parent Only)

After presenting the spec to the user and getting approval, use `freeze-and-queue.sh` for ALL Linear issue operations. **Do NOT create issues via inline `linear` commands or raw GraphQL — always use the script.**

### Create Parent Issue (new spec)

Write the spec content to a temp file and run the script with `--parent-only` to create ONLY the parent issue in Draft state (no sub-issues).

```bash
# Create parent issue only (no sub-issues):
cat /tmp/spec-content.md | bash ~/.claude/skills/spec-gen/scripts/freeze-and-queue.sh --parent-only <workflow-path>

# Or with a spec file:
bash ~/.claude/skills/spec-gen/scripts/freeze-and-queue.sh --parent-only <workflow-path> /tmp/spec-content.md

# Dry run first to verify parsing:
cat /tmp/spec-content.md | bash ~/.claude/skills/spec-gen/scripts/freeze-and-queue.sh --parent-only --dry-run <workflow-path>
```

The script automatically:
- Resolves the team ID and project ID from the WORKFLOW file's `project_slug`
- Looks up state UUIDs (Draft for parent)
- Creates the parent issue with `[Spec]` title prefix
- Prints the parent issue identifier and URL

Return the Linear deep link from the script output to the user for review.

### Update Parent Issue (iteration)

On subsequent invocations where the user requests changes:
1. Accept the change request in chat
2. Regenerate the spec with the requested changes
3. Update the existing parent issue using `--update` with `--parent-only` (no sub-issues during iteration):

```bash
cat /tmp/spec-content.md | bash ~/.claude/skills/spec-gen/scripts/freeze-and-queue.sh \
  --parent-only --update <PARENT_ISSUE_ID> <workflow-path>
```

4. Return the updated deep link from the script output

**Sync is always one-way.** Out-of-band edits in the Linear UI get overwritten on next sync.

### Upgrade Idea Issue

If the input was an existing `Idea` issue:
1. Use `--parent-only --update` with the existing issue ID to update its description and move it to Draft:

```bash
cat /tmp/spec-content.md | bash ~/.claude/skills/spec-gen/scripts/freeze-and-queue.sh \
  --parent-only --update <IDEA_ISSUE_ID> <workflow-path>
```

2. Return the deep link

### Debugging Reference

<details>
<summary>State UUID lookup (for debugging only — do NOT use for issue creation)</summary>

If you need to inspect team states for debugging purposes:

```bash
# List all statuses for a team (via GraphQL — no built-in statuses command)
linear api '{ workflowStates(filter: { team: { key: { eq: "SYMPH" } } }) { nodes { id name type } } }'

# List projects (optionally filter by team)
linear project list --team SYMPH

# Raw GraphQL via linear (uses configured auth automatically)
linear api '{ viewer { id name } }'
```

These queries are handled automatically by `freeze-and-queue.sh` during normal operation.

</details>

### Done — Next: Freeze

The parent issue is now in `Draft` state in Linear. Share the link with the user for review.

**When the user is ready to freeze** (create sub-issues for autonomous pipeline execution), they should invoke:

`/spec-freeze <PARENT_ISSUE_ID> <workflow-path>`

This is a separate skill invocation — the freeze operation is structurally separated to enforce the review gate.

---

## Parent Issue Lifecycle

```
Idea → Draft
         ↑
    (iterate via chat, one-way sync to Linear)
```

- **Idea**: Raw concept, no spec. Optional starting point.
- **Draft**: `/spec-gen` has run. Full spec in description. Actively iterating via chat.

---

## Gotchas

- **Don't invent requirements.** The spec should capture what was asked, not what you think should be asked. Scope creep is the most common spec generation artifact.
- **Verify lines are NOT tests.** They are behavioral checks run by the implementing agent. They should be fast, self-contained, and deterministic.
- **One-way sync only.** Never parse spec content back from Linear. The skill is the source of truth during iteration; Linear is the store.
- **Don't generate design.md for STANDARD features.** Only COMPLEX features need architectural documentation.

## Related Skills

- `/spec-freeze` — freeze a drafted spec into Linear sub-issues for autonomous pipeline execution
- `/pipeline-review` — headless adversarial review for the review stage (runs AFTER implementation)
- `/council-review` — multi-model cross-examination review (for highest-assurance review)
- `/adversarial-review` — interactive multi-model development + review cycle
