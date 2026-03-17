---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: 1fa66498be91
  active_states:
    - Todo
    - In Progress
  terminal_states:
    - Done
    - Cancelled

polling:
  interval_ms: 30000

workspace:
  root: ./workspaces

agent:
  max_concurrent_agents: 1
  max_turns: 30
  max_retry_backoff_ms: 300000

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
    echo "Cloning $REPO_URL into workspace..."
    git clone --depth 1 "$REPO_URL" .
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
    echo "Workspace setup complete."
  before_run: |
    set -euo pipefail
    echo "Syncing workspace with upstream..."
    git fetch origin
    CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
    if [ "$CURRENT_BRANCH" = "main" ] || [ "$CURRENT_BRANCH" = "master" ]; then
      echo "On $CURRENT_BRANCH — rebasing onto latest..."
      if ! git rebase origin/main 2>/dev/null; then
        echo "WARNING: Rebase failed, aborting rebase" >&2
        git rebase --abort
      fi
    else
      echo "On feature branch $CURRENT_BRANCH — skipping rebase, fetch only."
    fi
    echo "Workspace synced."
  timeout_ms: 120000

server:
  port: 4321

observability:
  dashboard_enabled: true
  refresh_ms: 5000

stages:
  initial_stage: investigate

  investigate:
    type: agent
    runner: claude-code
    model: claude-sonnet-4-5
    max_turns: 8
    on_complete: implement

  implement:
    type: agent
    runner: claude-code
    model: claude-sonnet-4-5
    max_turns: 30
    on_complete: review

  review:
    type: gate
    gate_type: ensemble
    max_rework: 3
    reviewers:
      - runner: gemini
        model: gemini-2.5-pro
        role: adversarial-reviewer
        prompt: |
          You are reviewing a small, scoped task from a Linear issue. The implementation was done by an autonomous agent.
          Focus on correctness relative to the issue description — does the code do what was asked?
          PASS if: the implementation is functionally correct, tests are present, and no obvious bugs exist.
          FAIL only for: broken logic, missing core requirements from the issue description, or code that would crash at runtime.
          Do NOT fail for: style preferences, missing comments, missing edge-case handling beyond the issue scope, or theoretical concerns that don't apply to the actual diff.
          Be pragmatic. These are small, well-scoped tasks — not production audits.
      - runner: gemini
        model: gemini-2.5-pro
        role: security-reviewer
        prompt: |
          You are reviewing a small, scoped task for security issues. Focus only on the actual code changes in the diff.
          PASS if: no injection vulnerabilities (SQL, command, XSS), no hardcoded secrets, no obviously broken auth checks.
          FAIL only for: concrete, exploitable vulnerabilities visible in the diff — not theoretical risks.
          Do NOT fail for: information disclosure on health/status endpoints, use of non-cryptographic randomness for non-security purposes, missing rate limiting, or theoretical timing attacks.
          The bar for FAIL is: "an attacker could exploit this specific code." If you can't describe the exploit, PASS.
    on_approve: merge
    on_rework: implement

  merge:
    type: agent
    runner: claude-code
    model: claude-sonnet-4-5
    max_turns: 5
    on_complete: done

  done:
    type: terminal
---

You are running in headless/unattended mode. Do NOT use interactive skills, slash commands, or plan mode. Do not prompt for user input. Complete your work autonomously.

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
- Read the codebase to understand existing patterns and architecture
- Identify which files need to change and what the approach should be
- Post a comment on the Linear issue (via `gh`) with your investigation findings and proposed implementation plan
- Do NOT implement code, create branches, or open PRs in this stage — investigation only
- When you have completed your investigation and posted your findings, output the exact text `[STAGE_COMPLETE]` as the very last line of your final message.
{% endif %}

{% if stageName == "implement" %}
## Stage: Implementation
You are in the IMPLEMENT stage. An investigation was done in the previous stage — check issue comments for the plan.

## Implementation Steps

1. Read any investigation notes from previous comments on this issue.
2. Create a feature branch from the issue's suggested branch name{% if issue.branch_name %} (`{{ issue.branch_name }}`){% endif %}, or use `{{ issue.identifier | downcase }}/<short-description>`.
3. Implement the task per the issue description.
4. Write tests as needed.
5. Run all `# Verify:` commands from the spec. You are not done until every verify command exits 0.
6. Commit your changes with message format: `feat({{ issue.identifier }}): <description>`.
7. Open a PR via `gh pr create` with the issue description in the PR body.
8. Link the PR to the Linear issue by including `{{ issue.identifier }}` in the PR title or body.
9. When you have opened the PR and all verify commands pass, output the exact text `[STAGE_COMPLETE]` as the very last line of your final message.
{% endif %}

{% if stageName == "merge" %}
## Stage: Merge
You are in the MERGE stage. The PR has been reviewed and approved.
- Merge the PR via `gh pr merge --squash --delete-branch`
- Verify the merge succeeded on the main branch
- Do NOT modify code in this stage
- When you have successfully merged the PR, output the exact text `[STAGE_COMPLETE]` as the very last line of your final message.
{% endif %}

## Scope Discipline

- If your task requires a capability that doesn't exist in the codebase and isn't specified in the spec, stop and comment what's missing on the issue. Don't scaffold unspecced infrastructure.
- Tests must be runnable against $BASE_URL (no localhost assumptions in committed tests).

## Documentation Maintenance

- If you add a new module, API endpoint, or significant abstraction, update the relevant docs/ file and the AGENTS.md Documentation Map entry. If no relevant doc exists, create one following the docs/ conventions (# Title, > Last updated header).
- If a docs/ file you reference during implementation is stale or missing, update/create it as part of your implementation. Include the update in the same PR as your code changes — never in a separate PR.
- If you make a non-obvious architectural decision during implementation, create a design doc in docs/design-docs/ following the ADR format (numbered, with Status line). Add it to the AGENTS.md design docs table.
- When you complete your implementation, update the > Last updated date on any docs/ file you modified.
- Do not update docs/generated/ files — those are auto-generated and will be overwritten.
- Commit doc updates in the same PR as code changes, not separately.
