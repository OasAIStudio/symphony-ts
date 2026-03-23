#!/usr/bin/env bash
set -euo pipefail

# before-run hook: Sync workspace with upstream before each agent run.
# Ensures the agent starts from the latest main branch state.

echo "Syncing workspace with upstream main..."
git fetch origin main

# Attempt rebase; abort if conflicts arise (agent starts from current state)
if ! git rebase origin/main 2>/dev/null; then
  echo "WARNING: Rebase failed due to conflicts, aborting rebase" >&2
  git rebase --abort
fi

echo "Workspace synced."
