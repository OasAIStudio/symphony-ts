# Complexity Router — Decision Tree

This is the first decision you make. Classify the brain dump BEFORE generating any artifacts.

## Classification Decision Tree

```
Is this a one-liner, bug fix, config change, or file operation?
├── YES → TRIVIAL
└── NO
    ├── How many capabilities does it touch?
    │   ├── 1 capability, ≤2 tasks, clear scope → STANDARD
    │   └── 2+ capabilities, OR architectural change, OR 7+ tasks → COMPLEX
    └── Ambiguous? → Default to STANDARD (see Signal Detection below)
```

---

## Tier Definitions

### TRIVIAL — Skip spec, create single Linear issue in Todo

**Definition**: A change with no design ambiguity. The description IS the implementation plan.

**Signals** (any ONE is sufficient):
- Single file changed
- Fix is mechanical (typo, version bump, env var, config toggle)
- No behavioral change to end users
- Copy/move/rename operation
- Dependency update with no API change
- Bug fix where the root cause and fix are already known

**Action**: Do NOT generate a spec. Create a single Linear issue directly in `Todo` state with:
- Title from the brain dump
- Description with enough detail for an agent to implement
- Priority based on urgency
- No parent issue, no sub-issues — symphony picks it up directly

**Examples**:
| Brain Dump | Why Trivial |
|------------|-------------|
| "Fix typo in README — 'recieve' should be 'receive'" | Single character fix, no design |
| "Update BASE_URL env var from port 3000 to 8080" | Config change, one file |
| "Copy the run-pipeline.sh script to the new repo" | File operation |
| "Bump Hono from 4.5 to 4.6" | Dependency update, no API change |
| "Add .wrangler/ to .gitignore" | Single-line config append |
| "Fix the 500 on DELETE /api/tasks when id is non-numeric — return 400 instead" | Bug fix with known root cause and known fix |

**Counter-examples (NOT trivial despite sounding simple)**:
| Brain Dump | Why NOT Trivial |
|------------|-----------------|
| "Add pagination" | Touches query logic, response shape, and possibly frontend — STANDARD |
| "Fix the slow API" | Root cause unknown, may require investigation — at least STANDARD |
| "Add dark mode" | Touches many files, needs design decisions — COMPLEX |

---

### STANDARD — Generate spec → parent issue in Draft → freeze to sub-issues

**Definition**: A single capability with clear scope that decomposes into 1-2 tasks.

**Signals** (most must be present):
- One new feature or one behavior change
- Touches 2-6 files
- Clear acceptance criteria can be written
- No architectural decisions needed (uses existing patterns)
- Can be described in 1-2 sentences
- Does not introduce new infrastructure (databases, queues, external services)

**Action**: Generate full spec as a single markdown document containing:
1. Problem/Solution/Scope — WHY this change matters
2. Gherkin scenarios with `# Verify:` lines (MANDATORY) and `# Test:` directives (optional)
3. Task list with Priority/Scope/Scenarios

Create a parent Linear issue in `Draft` state with the spec as the issue description. Iterate via chat. On freeze, create sub-issues in `Todo` and move parent to `Backlog`.

**Examples**:
| Brain Dump | Capabilities | Estimated Tasks |
|------------|-------------|-----------------|
| "Add pagination to GET /api/tasks — page, limit params, total count header" | 1 (pagination) | 3 (query logic, response format, edge cases) |
| "Add user authentication with email/password" | 1 (auth) | 4 (model, signup, login, middleware) |
| "Add a /health endpoint that returns service status and uptime" | 1 (health check) | 2 (endpoint, response format) |
| "Add rate limiting — 100 req/min per IP with 429 response" | 1 (rate limiting) | 3 (middleware, config, response) |
| "Add soft delete to tasks — deletedAt timestamp, exclude from listings" | 1 (soft delete) | 4 (schema migration, delete endpoint, list filter, restore endpoint) |
| "Add input validation with Zod schemas for all endpoints" | 1 (validation) | 3 (schemas, middleware, error formatting) |

---

### COMPLEX — Generate spec + ensemble gate → parent issue in Draft → freeze to sub-issues

**Definition**: A change that spans multiple capabilities, requires architectural decisions, or has cross-cutting concerns.

**Signals** (any ONE is sufficient):
- Introduces a new data model or significantly changes an existing one
- Requires a new external service integration (database, queue, third-party API)
- Touches 7+ files or 3+ distinct subsystems
- Has cross-cutting concerns (auth, logging, error handling that affects everything)
- Requires design tradeoffs with no obvious right answer
- Changes the system's deployment model or infrastructure
- Multiple stakeholders would have opinions

**Action**: Same as STANDARD, plus:
1. Include a `## Design` section in the spec — HOW (architecture decisions, tradeoffs, alternatives considered)
2. Run ensemble gate with PM/Architect/VoC reviewers before freeze
3. If ensemble returns CONCERNS, iterate on the spec before freezing
4. On freeze, add ensemble gate flag to sub-issues

**Examples**:
| Brain Dump | Why Complex |
|------------|-------------|
| "Redesign the data model to support multi-tenant" | New data model, cross-cutting (every query needs tenant scope) |
| "Add real-time sync with WebSocket support" | New infrastructure (WebSocket server), new data flow pattern |
| "Add a recommendation engine based on user behavior" | New subsystem (ML/analytics), new data pipeline |
| "Migrate from SQLite to PostgreSQL with connection pooling" | Infrastructure change, affects all queries |
| "Add an admin dashboard with role-based access control" | Multiple capabilities (dashboard, RBAC, UI), 10+ tasks |
| "Add offline support with conflict resolution" | Cross-cutting (sync, storage, conflict resolution, UI states) |

---

## Signal Detection for Ambiguous Cases

When a brain dump doesn't clearly fit one tier, use these disambiguation rules:

### Rule 1: When in doubt, choose STANDARD over TRIVIAL
A TRIVIAL classification means no spec is generated. If there's any chance the agent would benefit from Gherkin scenarios and verify lines, classify as STANDARD. The cost of an unnecessary spec is low; the cost of a missing spec is high (wasted implementation cycles, no verification).

### Rule 2: When in doubt between STANDARD and COMPLEX, check for cross-cutting
Ask: "Does this change require me to modify code I wasn't planning to modify?" If yes → COMPLEX. If the change is additive (new files, new endpoints) with no modification to existing code → STANDARD.

### Rule 3: "Add X" with a known pattern is STANDARD
If the brain dump says "add X" and you can point to an existing example of X in the codebase (or a well-known pattern), it's STANDARD. The pattern removes ambiguity.

### Rule 4: "Change X" or "redesign X" is usually COMPLEX
Modifications to existing behavior have higher blast radius than additions. If existing tests, contracts, or consumers are affected, lean COMPLEX.

### Rule 5: Count the unknowns
- 0 unknowns → TRIVIAL or STANDARD
- 1-2 unknowns → STANDARD (unknowns get resolved during spec generation)
- 3+ unknowns → COMPLEX (unknowns need architectural investigation)

### Rule 6: Estimate, then check
If you estimate 1-2 tasks → STANDARD. If you estimate 7+ tasks → COMPLEX. If you estimate 1 task → TRIVIAL (unless it's a behavioral change with verification needs).
<!-- TODO(SYMPH-57): This leaves a 3-6 task gap between STANDARD (≤2) and COMPLEX (7+). A follow-up issue should decide whether 3-6 tasks maps to COMPLEX or whether the COMPLEX threshold should be lowered to 3+. -->

---

## Existing Spec Detection

Before classifying, check for existing parent issues in the target Linear project:

- **No existing parent issue**: New spec — create a parent issue in `Draft` state.
- **Existing `Idea` issue**: Upgrade path — update the issue with generated spec and move to `Draft`.
- **Existing `Draft` issue for same capability**: Iteration — update the existing parent issue description (one-way sync).
- **Existing `Backlog` issue with sub-issues**: Already frozen — this is a new spec for a different capability, or requires unfreezing (out of scope for this skill).

### Signals that affect classification
- Existing specs in Linear cover the same capability → this is iteration on an existing `Draft`, not a new spec
- Existing specs cover adjacent capabilities → check for cross-cutting impact (may push STANDARD → COMPLEX)
- Existing sub-issues in `Todo` → spec is already frozen, this may be a new feature or a continuation requiring a separate parent

---

## Quick Reference Table

| Signal | Trivial | Standard | Complex |
|--------|---------|----------|---------|
| Files changed | 1 | 2-6 | 7+ |
| Tasks | 0-1 | 1-2 | 7+ |
| Capabilities | 0 | 1 | 2+ |
| Design decisions | None | Minimal | Multiple |
| Infrastructure changes | None | None | Yes |
| Cross-cutting concerns | No | No | Yes |
| Parent issue? | No (single Todo issue) | Yes (Draft → Backlog) | Yes (Draft → Backlog) |
| Spec in Linear? | No | Yes | Yes + Design section |
| Ensemble gate? | No | No | Yes |
| Unknowns | 0 | 0-2 | 3+ |
