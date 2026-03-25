#!/usr/bin/env bash
set -euo pipefail

# after-create hook: Set up a fresh workspace for an agent.
# Called by symphony-ts after creating the workspace directory.
# Expects REPO_URL to be set in the environment.

if [ -z "${REPO_URL:-}" ]; then
  echo "ERROR: REPO_URL environment variable is not set" >&2
  exit 1
fi

echo "Cloning $REPO_URL into workspace..."
git clone --depth 1 "$REPO_URL" .

# Install dependencies based on what's present
if [ -f package.json ]; then
  echo "Installing Node.js dependencies..."
  if [ -f pnpm-lock.yaml ]; then
    pnpm install --frozen-lockfile
  elif [ -f yarn.lock ]; then
    yarn install --frozen-lockfile
  else
    npm install
  fi
fi

if [ -f requirements.txt ]; then
  echo "Installing Python dependencies..."
  pip install -r requirements.txt
fi

echo "Workspace setup complete."
