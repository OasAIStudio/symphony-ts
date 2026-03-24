# Exploration Checklist — Targeted Codebase Discovery

This checklist guides Step 0 exploration. Use the brain dump keywords to scope your search.
Do NOT explore the entire codebase. Focus on what the brain dump touches.

---

## 1. Project Structure (always — takes 10 seconds)

Identify the basics that inform every subsequent decision.

**What you need:**
- Language and runtime (TypeScript/Bun, Python/Flask, Go, etc.)
- Package manager (bun, npm, pnpm, pip, cargo)
- Framework (Hono, Express, FastAPI, Gin, etc.)
- Build tool if applicable (tsc, vite, webpack)
- Entry point (main application file)

**How:** Read `package.json` (or equivalent), check for config files, glob for entry points.

## 2. Relevant Modules (use brain dump keywords)

Find the files and directories the brain dump would touch.

**How:**
- Grep for keywords from the brain dump (feature names, domain terms)
- Glob for related file names
- Read the entry point and trace the import chain to the affected area

**What you need:**
- Specific file paths that would change (not directory guesses)
- The module boundary — where does one concern end and another begin?
- Import/dependency chains — what else gets pulled in?

## 3. Existing Patterns (find the closest analog)

The most valuable discovery. Finding how a similar feature is already implemented saves the most spec-writing time.

**How:**
- Grep for patterns similar to what the brain dump describes
- Read a representative handler/controller/route end-to-end
- Note the layering: route definition → handler → service → data access

**What you need:**
- The closest existing analog to the requested feature
- How it is structured (what layers, what patterns)
- What conventions it follows (naming, error format, response shape)
- If no analog exists, note that explicitly — it changes classification

## 4. Test Infrastructure

Determines how verify lines and test directives should be written.

**How:**
- Glob for test files (`**/*.test.*`, `**/*.spec.*`, `**/test_*`)
- Read a representative test close to the affected area
- Check for test config files (`jest.config*`, `vitest.config*`, etc.)
- Check test scripts in package.json

**What you need:**
- Test runner and command to invoke it
- Test file location pattern (colocated vs. separate test directory)
- How fixtures/setup work (factories, seed data, beforeEach patterns)
- E2E test framework if present (Playwright, Cypress, etc.)

## 5. Schema and Data Model

If the brain dump touches data, understand the current model.

**How:**
- Glob for schema definitions (`**/schema*`, `**/migration*`, `**/models/*`)
- Grep for type/interface definitions related to the brain dump keywords
- Check for ORM patterns (prisma, drizzle, typeorm, sqlalchemy)

**What you need:**
- Tables/types/interfaces the change would affect
- Whether migrations exist and how they work
- The data access pattern (direct SQL, ORM, repository pattern)

## 6. Dependencies and External Services

Check what external dependencies the affected area uses.

**How:**
- Grep for service names, SDK names, API URL patterns in the affected area
- Check for environment variables used in the affected area

**What you need:**
- External services the affected area talks to
- Environment variables it needs
- SDKs or client libraries in use

## 7. Prior Art (git history)

Check if this has been attempted or related work exists.

**How:**
- `git log --oneline --all --grep="<keyword>"` for related commits
- `git branch -a | grep -i "<keyword>"` for related branches
- `git log --oneline -10 -- <affected-file-paths>` for recent changes

**What you need:**
- Whether this was tried before (and reverted?)
- Recent changes that might conflict
- Related features that were added recently

---

## Scoping the Exploration

The depth self-adjusts based on what you find:

**For a trivial-sounding brain dump** (typo fix, config change): Sections 1 and 2 only.
Confirm the file exists, confirm the fix is mechanical, done.

**For a standard-sounding brain dump** (add a feature): Sections 1-5.
Full exploration of the affected area but no cross-cutting investigation.

**For a complex-sounding brain dump** (redesign, new subsystem): Sections 1-7.
Full exploration including dependency chains, prior art, and cross-cutting concerns.

If Section 2 reveals the change touches 8 files across 3 modules, go deeper. If it shows a single-file change, wrap up quickly.

---

## Common Exploration Mistakes

- **Exploring everything**: Don't read files unrelated to the brain dump. Use the keywords to scope.
- **Stopping too early**: Finding the first relevant file is not enough. Trace the full call chain.
- **Ignoring tests**: The test landscape directly determines verify line quality. Always check.
- **Missing the analog**: If an existing feature does something similar, finding it saves the most spec-writing time. Invest here.
- **Not recording specifics**: "Uses TypeScript" is too vague. "TypeScript with Hono framework, Bun runtime, Drizzle ORM, tests in tests/ using bun test" is what the spec needs.
