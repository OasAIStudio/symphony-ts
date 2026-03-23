---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: fdba14472043
  active_states:
    - Todo
    - In Progress
    - In Review
    - Blocked
    - Resume
  terminal_states:
    - Done
    - Cancelled

escalation_state: Blocked

polling:
  interval_ms: 30000

workspace:
  root: ./workspaces

agent:
  max_concurrent_agents: 5
  max_turns: 30
  max_retry_backoff_ms: 300000

codex:
  stall_timeout_ms: 1800000

runner:
  kind: claude-code
  model: claude-sonnet-4-5

hooks:
  after_create: |
    set -euo pipefail
    if [ -z "${REPO_URL:-}" ]; then
      echo "ERROR: REPO_URL environment variable is not set" >&2
      exit 1
    fi

    # --- Derive bare clone path (absolute, shared across workers) ---
    REPO_SLUG=$(basename "${REPO_URL%.git}")
    BARE_CLONE_DIR="$(cd .. && pwd)/.bare-clones"
    BARE_CLONE="$BARE_CLONE_DIR/$REPO_SLUG"
    WORKSPACE_DIR="$PWD"
    ISSUE_KEY=$(basename "$WORKSPACE_DIR")
    BRANCH_NAME="worktree/$ISSUE_KEY"

    # --- Create bare clone if it doesn't exist (race-safe) ---
    mkdir -p "$BARE_CLONE_DIR"
    if [ ! -d "$BARE_CLONE" ]; then
      echo "Creating shared bare clone for $REPO_SLUG..."
      if ! git clone --bare "$REPO_URL" "$BARE_CLONE" 2>/dev/null; then
        # Another worker may have created it concurrently — verify it exists
        if [ ! -d "$BARE_CLONE" ]; then
          echo "ERROR: Failed to create bare clone at $BARE_CLONE" >&2
          exit 1
        fi
        echo "Bare clone already created by another worker."
      fi
    else
      echo "Using existing bare clone at $BARE_CLONE"
    fi

    # --- Fetch latest refs into bare clone ---
    git -C "$BARE_CLONE" fetch origin 2>/dev/null || echo "WARNING: fetch failed, using cached refs" >&2

    # --- Create worktree for this issue ---
    echo "Creating worktree for $ISSUE_KEY on branch $BRANCH_NAME..."
    git -C "$BARE_CLONE" worktree add "$WORKSPACE_DIR" -b "$BRANCH_NAME" main

    # --- Install dependencies ---
    if [ -f package.json ]; then
      if [ -f bun.lock ]; then
        bun install --frozen-lockfile
      elif [ -f pnpm-lock.yaml ]; then
        pnpm install --frozen-lockfile
      elif [ -f yarn.lock ]; then
        yarn install --frozen-lockfile
      else
        npm install
      fi
    fi
    # --- Build code graph (best-effort) ---
    if command -v code-review-graph >/dev/null 2>&1; then
      echo "Building code review graph..."
      code-review-graph build --repo . || echo "WARNING: code-review-graph build failed, continuing without graph" >&2
    else
      echo "WARNING: code-review-graph not installed, skipping graph build" >&2
    fi
    echo "Workspace setup complete (worktree: $BRANCH_NAME)."
  before_run: |
    set -euo pipefail
    echo "Syncing workspace with upstream..."

    # --- Resolve git dir (worktree .git is a file, not a directory) ---
    resolve_git_dir() {
      if [ -f .git ]; then
        # Worktree: .git is a file containing "gitdir: /path/to/.bare-clones/repo/worktrees/..."
        sed 's/^gitdir: //' .git
      elif [ -d .git ]; then
        echo ".git"
      else
        echo ""
      fi
    }
    GIT_DIR=$(resolve_git_dir)

    # --- Git lock handling (works for both worktrees and regular clones) ---
    wait_for_git_lock() {
      if [ -z "$GIT_DIR" ]; then return; fi
      local lock_file="$GIT_DIR/index.lock"
      local attempt=0
      while [ -f "$lock_file" ] && [ $attempt -lt 6 ]; do
        echo "WARNING: $lock_file exists, waiting 5s (attempt $((attempt+1))/6)..." >&2
        sleep 5
        attempt=$((attempt+1))
      done
      if [ -f "$lock_file" ]; then
        echo "WARNING: $lock_file still exists after 30s, removing stale lock" >&2
        rm -f "$lock_file"
      fi
    }

    # --- Git fetch with retry ---
    fetch_ok=false
    for attempt in 1 2 3; do
      wait_for_git_lock
      if git fetch origin 2>/dev/null; then
        fetch_ok=true
        break
      fi
      echo "WARNING: git fetch failed (attempt $attempt/3), retrying in 2s..." >&2
      sleep 2
    done
    if [ "$fetch_ok" = false ]; then
      echo "WARNING: git fetch failed after 3 attempts, continuing with stale refs" >&2
    fi

    # --- Rebase (best-effort) ---
    CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "unknown")
    if [ "$CURRENT_BRANCH" = "main" ] || [ "$CURRENT_BRANCH" = "master" ]; then
      echo "On $CURRENT_BRANCH — rebasing onto latest..."
      wait_for_git_lock
      # In bare clone worktrees, refs are stored as refs/heads/<branch>, not refs/remotes/origin/<branch>
      # Try origin/<branch> first (regular clone), fall back to <branch> (bare clone worktree)
      if git show-ref --verify --quiet "refs/remotes/origin/$CURRENT_BRANCH"; then
        REBASE_TARGET="origin/$CURRENT_BRANCH"
      else
        REBASE_TARGET="$CURRENT_BRANCH"
      fi
      if ! git rebase "$REBASE_TARGET" 2>/dev/null; then
        echo "WARNING: Rebase failed, aborting rebase" >&2
        git rebase --abort 2>/dev/null || true
      fi
    else
      echo "On feature branch $CURRENT_BRANCH — skipping rebase, fetch only."
    fi
    # Import investigation brief into CLAUDE.md if it exists
    if [ -f "INVESTIGATION-BRIEF.md" ]; then
      if ! grep -q "@INVESTIGATION-BRIEF.md" CLAUDE.md 2>/dev/null; then
        echo '' >> CLAUDE.md
        echo '@INVESTIGATION-BRIEF.md' >> CLAUDE.md
      fi
    fi
    # Import rebase brief into CLAUDE.md if it exists
    if [ -f "REBASE-BRIEF.md" ]; then
      if ! grep -q "@REBASE-BRIEF.md" CLAUDE.md 2>/dev/null; then
        echo '' >> CLAUDE.md
        echo '@REBASE-BRIEF.md' >> CLAUDE.md
      fi
    fi
    echo "Workspace synced."
  before_remove: |
    set -uo pipefail

    # --- Handle case where worktree was never fully set up ---
    if [ ! -e .git ]; then
      echo "No git repo in workspace, nothing to clean up."
      exit 0
    fi

    BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
    if [ -z "$BRANCH" ] || [ "$BRANCH" = "main" ] || [ "$BRANCH" = "master" ] || [ "$BRANCH" = "HEAD" ]; then
      exit 0
    fi

    echo "Cleaning up branch $BRANCH..."

    # --- Close any open PR for this branch ---
    PR_NUM=$(gh pr list --head "$BRANCH" --state open --json number --jq '.[0].number' 2>/dev/null || echo "")
    if [ -n "$PR_NUM" ]; then
      echo "Closing PR #$PR_NUM and deleting remote branch..."
      gh pr close "$PR_NUM" --delete-branch 2>/dev/null || true
    else
      echo "No open PR found, deleting remote branch..."
      git push origin --delete "$BRANCH" 2>/dev/null || true
    fi

    # --- Remove worktree entry from bare clone ---
    REPO_SLUG=$(basename "${REPO_URL%.git}")
    BARE_CLONE="$(cd .. && pwd)/.bare-clones/$REPO_SLUG"
    if [ -d "$BARE_CLONE" ]; then
      echo "Removing worktree entry from bare clone..."
      git -C "$BARE_CLONE" worktree remove "$PWD" --force 2>/dev/null || true
      git -C "$BARE_CLONE" branch -D "$BRANCH" 2>/dev/null || true
    fi
    echo "Cleanup complete."
  timeout_ms: 120000

server:
  port: 4321

observability:
  dashboard_enabled: true
  refresh_ms: 5000

stages:
  initial_stage: investigate

  # Fast-track: issues labeled "trivial" skip the investigate stage and start at implement.
  fast_track:
    label: trivial
    initial_stage: implement

  investigate:
    type: agent
    runner: claude-code
    model: claude-opus-4-6
    max_turns: 8
    linear_state: In Progress
    mcp_servers:
      code-review-graph:
        command: uvx
        args:
          - code-review-graph
          - serve
    on_complete: implement

  implement:
    type: agent
    runner: claude-code
    model: claude-opus-4-6
    max_turns: 30
    mcp_servers:
      code-review-graph:
        command: uvx
        args:
          - code-review-graph
          - serve
    on_complete: review

  review:
    type: agent
    runner: claude-code
    model: claude-opus-4-6
    max_turns: 15
    max_rework: 3
    linear_state: In Review
    on_complete: merge
    on_rework: implement

  merge:
    type: agent
    runner: claude-code
    model: claude-sonnet-4-5
    max_turns: 5
    on_complete: done
    on_rework: implement
    max_rework: 2

  done:
    type: terminal
    linear_state: Done
---

You are running in headless/unattended mode. Do NOT use interactive skills, slash commands, or plan mode. Do not prompt for user input. Complete your work autonomously.

You are working on the Symphony orchestrator (symphony-ts). This is the pipeline orchestration layer that schedules and coordinates autonomous development agents.

Implement only what your task specifies. If you encounter missing functionality that another task covers, add a TODO comment rather than implementing it. Do not refactor surrounding code or add unsolicited improvements.

Never hardcode localhost or 127.0.0.1. Use the $BASE_URL environment variable for all URL references. Set BASE_URL=localhost:<port> during local development.

# {{ issue.identifier }} — {{ issue.title }}

You are working on Linear issue {{ issue.identifier }}.

## Issue Description

{{ issue.description }}

{% if issue.labels.size > 0 %}
Labels: {{ issue.labels | join: ", " }}
{% endif %}

{% if stageName == "investigate" %}
## Stage: Investigation
You are in the INVESTIGATE stage. Your job is to analyze the issue and create an implementation plan.

{% if issue.state == "Resume" %}
## RESUME CONTEXT
This issue was previously blocked. Check the issue comments for a `## Resume Context` comment explaining what changed. Focus your investigation on the blocking reasons and what has been updated.
{% endif %}

- Read the codebase to understand existing patterns and architecture
- Identify which files need to change and what the approach should be
- Post a comment on the Linear issue (via `gh`) with your investigation findings and proposed implementation plan
- Do NOT implement code, create branches, or open PRs in this stage — investigation only

### Workpad (investigate)
After completing your investigation, create the workpad comment on this Linear issue.
**Preferred**: Write the workpad content to a local `workpad.md` file and call `sync_workpad` with `issue_id` and `file_path`. Save the returned `comment_id` for future updates.
**Fallback** (if `sync_workpad` is unavailable):
1. First, search for an existing workpad comment using `linear_graphql`:
   ```graphql
   query { issue(id: "{{ issue.id }}") { comments { nodes { id body } } } }
   ```
   Look for a comment whose body starts with `## Workpad`.
2. If no workpad comment exists, create one using `commentCreate`. If one exists, update it using `commentUpdate`.
3. Use this template for the workpad body:
   ```
   ## Workpad
   **Environment**: <hostname>:<workspace-path>@<git-short-sha>

   ### Plan
   - [ ] Step 1 derived from issue description
   - [ ] Step 2 ...
     - [ ] Substep if needed

   ### Acceptance Criteria
   - [ ] Criterion from issue requirements
   - [ ] ...

   ### Validation
   - `<test command from spec>`
   - `<any verify commands>`

   ### Notes
   - <timestamp> Investigation complete. Plan posted.

   ### Confusions
   (Only add this section if something in the issue was genuinely unclear.)
   ```
4. Fill the Plan and Acceptance Criteria sections from your investigation findings.

## Investigation Brief

After posting the workpad, write `INVESTIGATION-BRIEF.md` to the worktree root. This file gives the implement-stage agent a concise orientation without re-reading the codebase.

Keep the brief under ~200 lines (~4K tokens). Use exactly this structure:

```markdown
# Investigation Brief
## Issue: [ISSUE-KEY] — [Title]

## Objective
One-paragraph summary of what needs to be done and why.

## Relevant Files (ranked by importance)
1. `src/path/to/primary-file.ts` — Main file to modify. [What it does, why it matters]
2. `src/path/to/secondary-file.ts` — Related dependency. [What to know]
3. `tests/path/to/test-file.test.ts` — Existing tests. [Coverage notes]

## Key Code Patterns
- Pattern X is used for Y (see `file.ts:42-67`)
- The codebase uses Z convention for this type of change

## Architecture Context
- Brief description of relevant subsystem
- Data flow: A → B → C
- Key interfaces/types to be aware of

## Test Strategy
- Existing test files and what they cover
- Test patterns used (describe/it, vitest, mocking approach)
- Edge cases to cover

## Gotchas & Constraints
- Don't modify X because Y
- Z is deprecated, use W instead

## Key Code Excerpts
[2-3 most important code blocks with file path and line numbers]
```

## Completion Signals
When you are done:
- If investigation is complete and workpad is posted: output `[STAGE_COMPLETE]`
- If the spec is ambiguous or contradictory: output `[STAGE_FAILED: spec]` with an explanation
- If you hit infrastructure issues (API limits, network errors): output `[STAGE_FAILED: infra]` with details
{% endif %}

{% if stageName == "implement" %}
## Stage: Implementation
You are in the IMPLEMENT stage. Read INVESTIGATION-BRIEF.md first if it exists in the worktree root. It contains targeted findings from the investigation stage including relevant files, code patterns, architecture context, and test strategy. Use it to skip codebase exploration and go straight to implementation. If the file does not exist, fall back to reading issue comments for the investigation plan.

{% if reworkCount > 0 %}
## REWORK ATTEMPT {{ reworkCount }}

**First, determine the rework type:**

### If `REBASE-BRIEF.md` exists in the worktree root — this is a REBASE REWORK:
1. Read `REBASE-BRIEF.md` for context on conflicting files and recent main commits
2. Rebase the current branch onto `origin/main` and resolve all merge conflicts
3. Run all `# Verify:` commands from the spec to ensure the build still passes
4. Delete `REBASE-BRIEF.md` after successful rebase and verification
5. Do NOT modify code beyond what is necessary to resolve conflicts
6. If conflicts cannot be resolved cleanly, output `[STAGE_FAILED: verify]` with details

### Else if `## Review Findings` comments exist — this is a REVIEW REWORK:
Read ALL comments on this Linear issue starting with `## Review Findings`. These contain the specific findings you must fix.
- Fix ONLY the identified findings
- Do not modify code outside the affected files unless strictly necessary
- Do not reinterpret the spec
- If a finding conflicts with the spec, output `[STAGE_FAILED: spec]` with an explanation
{% endif %}

## Implementation Steps

1. Read any investigation notes from previous comments on this issue.
2. Create a feature branch from the issue's suggested branch name{% if issue.branch_name %} (`{{ issue.branch_name }}`){% endif %}, or use `{{ issue.identifier | downcase }}/<short-description>`.
3. Implement the task per the issue description.
4. Write tests as needed.
5. Run all `# Verify:` commands from the spec. You are not done until every verify command exits 0.
6. Before creating the PR, capture structured tool output:
   - Run `npx tsc --noEmit 2>&1` and include output in PR body under `## Tool Output > TypeScript`
   - Run `npm test 2>&1` and include summary in PR body under `## Tool Output > Tests`
   - Run `semgrep scan --config auto --json 2>&1` (if available) and include raw output in PR body under `## SAST Output`
   - Do NOT filter or interpret SAST results — include them verbatim.
7. Commit your changes with message format: `feat({{ issue.identifier }}): <description>`.
8. Open a PR targeting this repo (not its upstream fork parent) via `gh pr create --repo $(git remote get-url origin | sed "s|.*github.com/||;s|\.git$||")` with the issue description in the PR body. Include the Tool Output and SAST Output sections.
9. Link the PR to the Linear issue by including `{{ issue.identifier }}` in the PR title or body.

### Workpad (implement)
Update the workpad comment at these milestones during implementation.
**Preferred**: Edit your local `workpad.md` file and call `sync_workpad` with `issue_id`, `file_path`, and `comment_id` (from the investigate stage).
**Fallback** (if `sync_workpad` is unavailable):
1. Search for the existing workpad comment (body starts with `## Workpad`) using `linear_graphql`:
   ```graphql
   query { issue(id: "{{ issue.id }}") { comments { nodes { id body } } } }
   ```
2. Update it using `commentUpdate` with the comment's `id`.
3. At each milestone, update the relevant sections:
   - **After starting implementation**: Check off Plan items as you complete them.
   - **After implementation is done**: Add a Notes entry (e.g., `- <timestamp> Implementation complete. PR #<number> opened.`), update Validation with actual commands run.
   - **After all tests pass**: Check off Acceptance Criteria items, add a Notes entry confirming validation.
4. Do NOT update the workpad after every small code change — only at the milestones above.
5. If no workpad comment exists (e.g., investigation stage was skipped), create one using the template from the investigate stage instructions.

10. **If your changes are app-touching** (UI, API responses visible to users, frontend assets), capture a screenshot after validation passes and embed it in the workpad:
   - Take a screenshot (e.g., `npx playwright screenshot` or `curl` the endpoint and save the response).
   - Upload it using the fileUpload flow described in the **Media in Workpads** section.
   - Add the image to the workpad comment under Notes: `![screenshot after validation](assetUrl)`.
   - Skip this step for non-visual changes (library code, configs, internal refactors).

## Completion Signals
When you are done:
- If all verify commands pass and PR is created: output `[STAGE_COMPLETE]`
- If you cannot resolve a verify failure after 3 attempts: output `[STAGE_FAILED: verify]` with the failing command and output
- If the spec is ambiguous or contradictory: output `[STAGE_FAILED: spec]` with an explanation
- If you hit infrastructure issues (API limits, network errors): output `[STAGE_FAILED: infra]` with details
{% endif %}

{% if stageName == "review" %}
## Stage: Review
You are a review agent. Load and execute the /pipeline-review skill.

The PR for this issue is on the current branch. The issue description contains the frozen spec. The PR body contains Tool Output and SAST Output sections from the implementation agent.

If all findings are clean or only P3/theoretical: output `[STAGE_COMPLETE]`
If surviving P1/P2 findings exist: post them as a `## Review Findings` comment on the Linear issue, then output `[STAGE_FAILED: review]` with a one-line summary.
{% endif %}

{% if stageName == "merge" %}
## Stage: Merge
You are in the MERGE stage. The PR has been reviewed and approved.

### Merge Queue Context
This repo uses GitHub's merge queue. When you run `gh pr merge`, GitHub will:
- **If checks passed**: Add the PR to the merge queue. You'll see: `"✓ Pull request ...#N will be added to the merge queue for main when ready"`
- **If checks pending**: Enable auto-merge. You'll see: `"✓ Pull request ...#N will be automatically merged via squash when all requirements are met"`

In BOTH cases, the merge is not immediate — GitHub queues it, rebases, runs CI on the rebased version, then merges. This is normal behavior. Do NOT interpret it as a failure.

### Step 1: Merge the PR
Run `gh pr merge --squash --delete-branch --repo $(git remote get-url origin | sed "s|.*github.com/||;s|\.git$||")`. This single command is sufficient. Do NOT:
- Retry the merge command if you see a "merge queue" or "auto-merge" response — that IS success
- Run `gh pr merge` with `--admin` to bypass the queue
- Modify any code in this stage

### Step 2: Wait for Merge to Complete
After the merge command succeeds, wait for the merge queue to finish:
```
gh pr checks --watch --required --fail-fast
```
This blocks until all checks complete (including merge queue CI). Then confirm the PR merged:
```
gh pr view --json state --jq '.state'
```
Expected: `MERGED`. If the state is `MERGED`, proceed to workpad update.

If the merge queue rejects the PR (check failures on rebased code), run `gh pr view --json state,statusCheckRollup` to understand the failure, then output `[STAGE_FAILED: rebase]` — the queue failure means the code doesn't work after rebase against latest main.

### Step 2b: If Conflicts — Write Rebase Brief and Signal Failure
If the PR has merge conflicts (mergeable is "CONFLICTING" or mergeStateStatus indicates conflicts):
1. Do NOT attempt to resolve conflicts — detect and signal only
2. Write `REBASE-BRIEF.md` to the worktree root with the following structure (keep under ~50 lines):
   ```markdown
   # Rebase Brief
   ## Issue: {{ issue.identifier }} — {{ issue.title }}

   ## Conflicting Files
   - `path/to/conflicted-file.ts` — nature of conflict if identifiable

   ## Recent Main Commits
   (output of git log origin/main --oneline -10 since branch diverged)

   ## Semantic Context
   - Any observations about what the conflicting PRs changed (from PR titles/commits)
   ```
3. To identify conflicting files, run `git fetch origin && git merge-tree $(git merge-base HEAD origin/main) HEAD origin/main` or attempt a dry-run merge
4. To get recent main commits, run `git log origin/main --oneline -10`
5. Output `[STAGE_FAILED: rebase]` as the very last line of your final message

### Workpad (merge)
After merging the PR, update the workpad comment one final time.
**Preferred**: Edit your local `workpad.md` file and call `sync_workpad` with `issue_id`, `file_path`, and `comment_id`.
**Fallback** (if `sync_workpad` is unavailable):
1. Search for the existing workpad comment (body starts with `## Workpad`) using `linear_graphql`:
   ```graphql
   query { issue(id: "{{ issue.id }}") { comments { nodes { id body } } } }
   ```
2. Update it using `commentUpdate`:
   - Check off all remaining Plan and Acceptance Criteria items.
   - Add a final Notes entry: `- <timestamp> PR merged. Issue complete.`

- When you have successfully merged the PR, output the exact text `[STAGE_COMPLETE]` as the very last line of your final message.
{% endif %}
## Scope Discipline

- If your task requires a capability that doesn't exist in the codebase and isn't specified in the spec, stop and comment what's missing on the issue. Don't scaffold unspecced infrastructure.
- Tests must be runnable against $BASE_URL (no localhost assumptions in committed tests).

## Workpad Rules

You maintain a single persistent `## Workpad` comment on the Linear issue. This is your structured progress document.

**Critical rules:**
- **Never create multiple workpad comments.** Always search for an existing comment with `## Workpad` in its body before creating a new one.
- **Update at milestones only** — plan finalized, implementation done, validation complete. Do NOT sync after every minor change.
- **Prefer `sync_workpad` over raw GraphQL.** Write your workpad content to a local `workpad.md` file, then call `sync_workpad` with `issue_id`, `file_path`, and optionally `comment_id` (returned from the first sync). This keeps the workpad body out of your conversation context and saves tokens. Fall back to `linear_graphql` only if `sync_workpad` is unavailable.
- **`linear_graphql` fallback patterns** (use only if `sync_workpad` is unavailable):
  - Search comments: `query { issue(id: "<issue_id>") { comments { nodes { id body } } } }`
  - Create comment: `mutation { commentCreate(input: { issueId: "<issue_id>", body: "<markdown>" }) { comment { id } } }`
  - Update comment: `mutation { commentUpdate(id: "<comment_id>", input: { body: "<markdown>" }) { comment { id } } }`
- **Never use `__type` or `__schema` introspection queries** against the Linear API. Use the exact patterns above.

## Media in Workpads (fileUpload)

When you capture evidence (screenshots, recordings, logs) during implementation, embed them in the workpad using Linear's `fileUpload` API. This is a 3-step flow:

**Step 1: Get upload URL** via `linear_graphql`:
```graphql
mutation($filename: String!, $contentType: String!, $size: Int!) {
  fileUpload(filename: $filename, contentType: $contentType, size: $size, makePublic: true) {
    success
    uploadFile { uploadUrl assetUrl headers { key value } }
  }
}
```

**Step 2: Upload file bytes** using `curl`:
```bash
# Build header flags from the returned headers array
curl -X PUT -H "Content-Type: <contentType>" \
  -H "<key1>: <value1>" -H "<key2>: <value2>" \
  --data-binary @<local-file-path> "<uploadUrl>"
```

**Step 3: Embed in workpad** — add `![description](assetUrl)` to the workpad comment body (either via `sync_workpad` or `commentUpdate`).

**Supported content types**: `image/png`, `image/jpeg`, `image/gif`, `video/mp4`, `application/pdf`.

**When to capture media**: Only when evidence adds value — screenshots of UI changes, recordings of interaction flows, or error screenshots for debugging. Do not upload media for non-visual tasks (e.g., pure API or library changes).

## Documentation Maintenance

- If you add a new module, API endpoint, or significant abstraction, update the relevant docs/ file and the AGENTS.md Documentation Map entry. If no relevant doc exists, create one following the docs/ conventions (# Title, > Last updated header).
- If a docs/ file you reference during implementation is stale or missing, update/create it as part of your implementation. Include the update in the same PR as your code changes — never in a separate PR.
- If you make a non-obvious architectural decision during implementation, create a design doc in docs/design-docs/ following the ADR format (numbered, with Status line). Add it to the AGENTS.md design docs table.
- When you complete your implementation, update the > Last updated date on any docs/ file you modified.
- Do not update docs/generated/ files — those are auto-generated and will be overwritten.
- Commit doc updates in the same PR as code changes, not separately.
