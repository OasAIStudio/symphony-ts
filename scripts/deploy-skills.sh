#!/usr/bin/env bash
set -euo pipefail

SKILLS_DIR="$HOME/.claude/skills/"
REMOTE_DIR="~/.claude/skills/"
HOST=""
DRY_RUN=""

usage() {
  echo "Usage: $0 --host user@server [--dry-run]"
  exit 1
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --host) HOST="$2"; shift 2 ;;
    --dry-run) DRY_RUN="--dry-run"; shift ;;
    *) echo "Unknown option: $1"; usage ;;
  esac
done

[[ -z "$HOST" ]] && { echo "Error: --host is required"; usage; }

if [[ ! -d "$SKILLS_DIR" ]]; then
  echo "Error: Skills directory not found at $SKILLS_DIR"
  exit 1
fi

echo "Deploying skills to $HOST"
[[ -n "$DRY_RUN" ]] && echo "(dry run — no files will be transferred)"
echo ""

rsync -avz $DRY_RUN \
  --exclude '.DS_Store' \
  --exclude 'node_modules' \
  --exclude '__pycache__' \
  "$SKILLS_DIR" "$HOST:$REMOTE_DIR"

echo ""
echo "Done. Skills synced to $HOST:$REMOTE_DIR"
