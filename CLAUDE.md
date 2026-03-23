# Symphony-ts

Autonomous development pipeline orchestrator. Fork of OasAIStudio/symphony-ts, maintained at github.com/mobilyze-llc/symphony-ts. Symphony reads work items from Linear, creates isolated per-issue workspaces, runs coding agents (Claude Code, Codex, Gemini) inside those workspaces, and handles retries, state transitions, and operator observability. It is the scheduling layer in a 4-stage pipeline: investigate, implement, review, merge.

## Project Overview

Symphony-ts is a CLI tool (no dev server). It polls a Linear project board for eligible issues, clones target repos into deterministic workspaces, renders LiquidJS prompt templates with issue context, dispatches agent runs, and manages the full lifecycle including retry/rework with failure classification. WORKFLOW.md files define per-product pipeline configuration. Hook scripts handle workspace setup and git sync.

## Architecture

```
src/
├── agent/           # Agent runner abstraction, prompt builder (LiquidJS rendering)
├── cli/             # CLI entrypoint (main.ts) — parses args, bootstraps orchestrator
├── codex/           # Codex app-server integration
├── config/          # WORKFLOW.md parsing, config resolution, defaults, file watcher
├── domain/          # Core domain model (issues, states, transitions)
├── errors/          # Error types and failure classification
├── logging/         # Structured logging
├── observability/   # Dashboard server (SSE), runtime metrics
├── orchestrator/    # Core loop, gate handler, runtime host — the main scheduling engine
├── runners/         # Agent runtime implementations (claude-code, gemini, factory)
├── shared/          # Shared utilities
├── tracker/         # Linear API client, GraphQL queries, state normalization
└── workspace/       # Workspace lifecycle (create, hooks, path safety)

pipeline-config/
├── hooks/           # Shell scripts: after-create.sh (clone + install), before-run.sh (git sync)
├── prompts/         # LiquidJS templates: investigate, implement, review, merge, global
├── templates/       # WORKFLOW and CLAUDE.md templates
├── workflows/       # Per-product WORKFLOW configs (symphony, jony-agent, hs-*, stickerlabs, household, TOYS)
└── workspaces/      # Runtime workspace directories (UUID-named, gitignored)

tests/               # Vitest test suite, mirrors src/ structure + fixtures/
dist/                # Compiled output (generated, not committed)
```

**Data flow**: WORKFLOW.md (YAML frontmatter + LiquidJS body) -> config resolver -> orchestrator polls Linear -> creates workspace (after-create hook clones repo) -> renders prompt template with issue context -> dispatches agent run -> agent works in isolated workspace -> orchestrator manages state transitions back to Linear.

**Key architectural decisions**:
- In-memory state only (no BullMQ/Redis) -- designed for 2-3 concurrent workers
- `strictVariables: true` on LiquidJS -- all template variables must be in render context
- Orchestrator is deliberately "dumb" -- review intelligence, failure classification, and feedback injection live in the agent layer (prompts + skills), not here
- `permissionMode: "bypassPermissions"` required for headless agent runs

## Build & Run

```bash
# Install dependencies
pnpm install

# Build (compiles TypeScript to dist/)
pnpm build            # or: npm run build

# Run the pipeline for a specific product
./run-pipeline.sh <product>
# Products: symphony, jony-agent, hs-data, hs-ui, hs-mobile, stickerlabs, household

# Run directly (after building)
node dist/src/cli/main.js <workflow-path> --acknowledge-high-trust-preview

# Type check only
pnpm typecheck        # or: npx tsc --noEmit

# Lint
pnpm lint             # Biome check

# Auto-format
pnpm format           # Biome format
```

No dev server -- this is a CLI tool. The D40 port table does not apply.

## Conventions

- **Runtime**: Node.js >= 22, pnpm >= 10, TypeScript strict mode, ES2023 target
- **Module system**: ESM (`"type": "module"`), NodeNext module resolution
- **Imports**: `import type { ... }` for type-only imports (`verbatimModuleSyntax: true`), `.js` extensions required for NodeNext
- **Formatting**: Biome -- spaces (not tabs), double quotes, semicolons always, trailing commas
- **Naming**: kebab-case for file names, PascalCase for types/interfaces, camelCase for functions/variables
- **Validation**: Zod for config/input validation at I/O boundaries
- **Templates**: LiquidJS for prompt rendering -- always pass all required variables (strictVariables is on)
- **Strict TS options**: `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `useUnknownInCatchVariables`, `noImplicitOverride`

## Testing

- **Framework**: Vitest
- **Run tests**: `pnpm test` (runs all 347 tests once via `node scripts/test.mjs`)
- **Watch mode**: `pnpm test:watch`
- **Location**: `tests/` directory, mirrors `src/` structure (e.g., `tests/orchestrator/core.test.ts` covers `src/orchestrator/core.ts`)
- **Fixtures**: `tests/fixtures/` for shared test data
- **Coverage**: All new code must have tests. Critical paths (orchestrator, config resolution, tracker) have thorough coverage.
- **Naming**: Test files named after the module they cover; individual test cases named after observable behavior.

## Pipeline Notes

### Critical: dist/ staleness

**The pipeline runs from compiled `dist/`, NOT source.** If you modify source files but forget to rebuild, your changes will not take effect. `run-pipeline.sh` includes a staleness check that compares `src/` timestamps against `dist/src/cli/main.js`. Use `--auto-build` to rebuild automatically, or `--skip-build-check` to bypass.

### Auto-generated files (never edit directly)
- `dist/` -- compiled output, regenerated by `pnpm build`
- `pipeline-config/workspaces/` -- runtime workspace directories (UUID-named)
- `pnpm-lock.yaml` -- dependency lock file (regenerated by `pnpm install`)

### Required environment variables
- `LINEAR_API_KEY` -- Linear API token for tracker integration (loaded from `.env` by `run-pipeline.sh`)
- `REPO_URL` -- target repo URL for workspace cloning (set per-product in `run-pipeline.sh`, or override via env)

### Fragile areas
- **`active_states` in WORKFLOW configs** must include ALL states set during execution (In Progress, In Review, Blocked, Resume). This bug has been hit 3 times -- missing a state causes silent failures.
- **LiquidJS `strictVariables: true`** -- any variable referenced in a prompt template that is not passed in the render context will throw. Always verify template variables match the context passed by `prompt-builder.ts`.
- **`scheduleRetry`** is used for both failures AND continuations -- the max retry limit must only count actual failures, not continuation retries.
- **Hook scripts** run with `cwd: workspacePath`, NOT the WORKFLOW.md location. Relative paths in hooks resolve against the workspace.
- **`issue.state`** is a string in LiquidJS context (via `toTemplateIssue`), not an object. Template conditionals must compare against string values.
- **`stall_timeout_ms`** default (5 min) is too short for Claude Code agents. Set to 900000 (15 min) in WORKFLOW configs.
- **Linear project slug** is the `slugId` UUID, not the team key.

### Verify commands (must pass before any PR)
```bash
pnpm test             # All 347 tests pass
pnpm build            # Compiles without errors
pnpm typecheck        # No type errors
pnpm lint             # Biome passes
```

### Scope boundaries
- Do NOT add BullMQ, Redis, or external queue infrastructure -- in-memory state is a deliberate design choice at current scale
- Do NOT move review intelligence or failure classification into the orchestrator -- these belong in the agent layer (prompts + skills)
- Do NOT modify hook scripts without testing against actual workspace creation flow
- Do NOT commit secrets to `.env` in public contexts (current repo is private; audit before making public)
- Every non-Claude-Code component should be designed for removal when Anthropic ships equivalent features
