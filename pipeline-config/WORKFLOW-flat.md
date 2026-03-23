---
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: 1fa66498be91
  active_states:
    - Todo
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
    echo "Syncing workspace with upstream main..."
    git fetch origin main
    if ! git rebase origin/main 2>/dev/null; then
      echo "WARNING: Rebase failed, aborting rebase" >&2
      git rebase --abort
    fi
    echo "Workspace synced."
  timeout_ms: 120000

server:
  port: 4321

observability:
  dashboard_enabled: true
  refresh_ms: 5000
---

You are running in headless/unattended mode. Do NOT use interactive skills, slash commands, or plan mode. Do not prompt for user input. Complete your work autonomously.

Implement only what your task specifies. If you encounter missing functionality that another task covers, add a TODO comment rather than implementing it. Do not refactor surrounding code or add unsolicited improvements.

Never hardcode localhost or 127.0.0.1. Use the $BASE_URL environment variable for all URL references. Set BASE_URL=localhost:<port> during local development.

# Implementation: {{ issue.identifier }} — {{ issue.title }}

You are implementing Linear issue {{ issue.identifier }}.

## Issue Description

{{ issue.description }}

{% if issue.labels.size > 0 %}
Labels: {{ issue.labels | join: ", " }}
{% endif %}

## Implementation Steps

1. Read any investigation notes from previous comments on this issue.
2. Create a feature branch from the issue's suggested branch name{% if issue.branch_name %} (`{{ issue.branch_name }}`){% endif %}, or use `{{ issue.identifier | downcase }}/<short-description>`.
3. Implement the task per the issue description.
4. Write tests as needed.
5. Run all `# Verify:` commands from the spec. You are not done until every verify command exits 0.
6. Commit your changes with message format: `feat({{ issue.identifier }}): <description>`.
7. Open a PR targeting this repo (not its upstream fork parent) via `gh pr create --repo $(git remote get-url origin | sed "s|.*github.com/||;s|\.git$||")` with the issue description in the PR body.
8. Link the PR to the Linear issue by including `{{ issue.identifier }}` in the PR title or body.

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
