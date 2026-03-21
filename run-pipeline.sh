#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Save caller's REPO_URL before sourcing .env
_CALLER_REPO_URL="${REPO_URL:-}"

# Source .env for LINEAR_API_KEY etc.
if [[ -f "$SCRIPT_DIR/.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/.env"
  set +a
fi

# REPO_URL priority: caller env > script lookup table (not .env)
# .env may set REPO_URL for other tools, but this script uses its own product mapping
if [[ -n "$_CALLER_REPO_URL" ]]; then
  REPO_URL="$_CALLER_REPO_URL"
else
  unset REPO_URL
fi
unset _CALLER_REPO_URL

usage() {
  cat <<'EOF'
Usage: ./run-pipeline.sh <product> [additional-args...]

Launch the symphony-ts pipeline for a product.

Products:
  symphony      Symphony orchestrator (github.com/ericlitman/symphony-ts)
  jony-agent    Jony Agent
  hs-data       Household Services Data
  hs-ui         Household Services UI
  hs-mobile     Household Services Mobile
  stickerlabs   Stickerlabs Factory (github.com/ericlitman/stickerlabs-factory)
  household     Household

Options:
  -h, --help          Show this help message
  --auto-build        Automatically run 'npm run build' if dist is stale
  --skip-build-check  Skip the dist staleness check entirely

Environment:
  REPO_URL      Override the default repo URL for the product
                Example: REPO_URL=https://github.com/org/repo.git ./run-pipeline.sh symphony

EOF
  exit 0
}

# Show help if no args or help flag
if [[ $# -eq 0 ]] || [[ "$1" == "--help" ]] || [[ "$1" == "-h" ]]; then
  usage
fi

PRODUCT="$1"
shift

# Parse flags before passing remaining args to symphony
AUTO_BUILD=false
SKIP_BUILD_CHECK=false
PASSTHROUGH_ARGS=()
for arg in "$@"; do
  case "$arg" in
    --auto-build) AUTO_BUILD=true ;;
    --skip-build-check) SKIP_BUILD_CHECK=true ;;
    *) PASSTHROUGH_ARGS+=("$arg") ;;
  esac
done
set -- "${PASSTHROUGH_ARGS[@]+"${PASSTHROUGH_ARGS[@]}"}"

# Map product → workflow file and default repo URL
case "$PRODUCT" in
  symphony)
    WORKFLOW="pipeline-config/workflows/WORKFLOW-symphony.md"
    DEFAULT_REPO_URL="https://github.com/ericlitman/symphony-ts.git"
    ;;
  jony-agent)
    WORKFLOW="pipeline-config/workflows/WORKFLOW-jony-agent.md"
    DEFAULT_REPO_URL="TBD"
    ;;
  hs-data)
    WORKFLOW="pipeline-config/workflows/WORKFLOW-hs-data.md"
    DEFAULT_REPO_URL="TBD"
    ;;
  hs-ui)
    WORKFLOW="pipeline-config/workflows/WORKFLOW-hs-ui.md"
    DEFAULT_REPO_URL="TBD"
    ;;
  hs-mobile)
    WORKFLOW="pipeline-config/workflows/WORKFLOW-hs-mobile.md"
    DEFAULT_REPO_URL="TBD"
    ;;
  stickerlabs)
    WORKFLOW="pipeline-config/workflows/WORKFLOW-stickerlabs.md"
    DEFAULT_REPO_URL="https://github.com/ericlitman/stickerlabs-factory.git"
    ;;
  household)
    WORKFLOW="pipeline-config/workflows/WORKFLOW-household.md"
    DEFAULT_REPO_URL="TBD"
    ;;
  *)
    echo "Error: Unknown product '$PRODUCT'"
    echo ""
    echo "Available products: symphony, jony-agent, hs-data, hs-ui, hs-mobile, stickerlabs, household"
    echo "Run './run-pipeline.sh --help' for details."
    exit 1
    ;;
esac

# Use env override if set, otherwise use default
REPO_URL="${REPO_URL:-$DEFAULT_REPO_URL}"

# For TBD products, require explicit REPO_URL
if [[ "$REPO_URL" == "TBD" ]]; then
  echo "Error: No default REPO_URL for '$PRODUCT' — set it via environment variable:"
  echo ""
  echo "  REPO_URL=https://github.com/org/repo.git ./run-pipeline.sh $PRODUCT"
  exit 1
fi

export REPO_URL

WORKFLOW_PATH="$SCRIPT_DIR/$WORKFLOW"

if [[ ! -f "$WORKFLOW_PATH" ]]; then
  echo "Error: Workflow file not found: $WORKFLOW_PATH"
  echo "Create the workflow file first, then retry."
  exit 1
fi

# --- Stale dist check ---
if [[ "$SKIP_BUILD_CHECK" != "true" ]]; then
  DIST_ENTRY="$SCRIPT_DIR/dist/src/cli/main.js"
  if [[ ! -f "$DIST_ENTRY" ]]; then
    echo "Error: dist/ not found ($DIST_ENTRY)"
    echo "  This looks like a fresh clone. Run 'npm run build' first."
    if [[ "$AUTO_BUILD" == "true" ]]; then
      echo "  --auto-build: running 'npm run build'..."
      (cd "$SCRIPT_DIR" && npm run build)
    else
      echo "  Or re-run with --auto-build to build automatically."
      exit 1
    fi
  elif [[ -n "$(find "$SCRIPT_DIR/src" -newer "$DIST_ENTRY" -type f 2>/dev/null)" ]]; then
    echo "Warning: dist/ is stale — source files are newer than dist/src/cli/main.js"
    if [[ "$AUTO_BUILD" == "true" ]]; then
      echo "  --auto-build: running 'npm run build'..."
      (cd "$SCRIPT_DIR" && npm run build)
    else
      echo "  Run 'npm run build' in symphony-ts/, or re-run with --auto-build."
      exit 1
    fi
  fi
fi

echo "Launching pipeline for: $PRODUCT"
echo "  Workflow: $WORKFLOW"
echo "  Repo URL: $REPO_URL"
echo ""

exec node "$SCRIPT_DIR/dist/src/cli/main.js" "$WORKFLOW_PATH" --acknowledge-high-trust-preview "$@"
