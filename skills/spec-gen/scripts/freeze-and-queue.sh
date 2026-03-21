#!/usr/bin/env bash
# freeze-and-queue.sh — Creates parent + sub-issue hierarchy in Linear from a spec
# Decision 32: Linear as spec store — specs live as Linear issues, not filesystem files.
#
# Usage:
#   bash freeze-and-queue.sh [--dry-run] [--parent-only] [--update ISSUE_ID] <workflow-path> [spec-file]
#   cat spec.md | bash freeze-and-queue.sh [--dry-run] [--parent-only] <workflow-path>
#   bash freeze-and-queue.sh --trivial "Issue title" <workflow-path>
#   echo "description" | bash freeze-and-queue.sh --trivial "Issue title" <workflow-path>
#
# The WORKFLOW file provides: project_slug (from YAML frontmatter)
# Auth: Uses linear-cli's configured auth (OAuth or --api-key).
# Team ID is resolved from the project via the Linear API.

set -euo pipefail

# ── Parse flags ──────────────────────────────────────────────────────────────

DRY_RUN=false
UPDATE_ISSUE_ID=""
PARENT_ONLY=false
TRIVIAL=false
TRIVIAL_TITLE=""
POSITIONAL=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)      DRY_RUN=true; shift ;;
    --update)       shift; UPDATE_ISSUE_ID="${1:-}"; shift ;;
    --parent-only)  PARENT_ONLY=true; shift ;;
    --trivial)      TRIVIAL=true; shift; TRIVIAL_TITLE="${1:-}"; shift ;;
    *)              POSITIONAL+=("$1"); shift ;;
  esac
done

WORKFLOW_PATH="${POSITIONAL[0]:-}"
SPEC_FILE="${POSITIONAL[1]:-}"

if [[ -z "$WORKFLOW_PATH" ]]; then
  echo "Usage: freeze-and-queue.sh [--dry-run] [--parent-only] [--update ISSUE_ID] [--trivial TITLE] <workflow-path> [spec-file]" >&2
  echo "  --trivial TITLE  Create a single issue in Todo state (no spec, no parent/sub-issue hierarchy)" >&2
  echo "  If no spec-file is given, reads spec content from stdin." >&2
  exit 1
fi

if [[ ! -f "$WORKFLOW_PATH" ]]; then
  echo "ERROR: WORKFLOW file not found: $WORKFLOW_PATH" >&2
  exit 1
fi

# ── Trivial mode: single issue in Todo, no spec ─────────────────────────────

if [[ "$TRIVIAL" == true ]]; then
  if [[ -z "$TRIVIAL_TITLE" ]]; then
    echo "ERROR: --trivial requires a title argument." >&2
    echo "  Usage: freeze-and-queue.sh --trivial 'Fix the typo in README' <workflow-path>" >&2
    exit 1
  fi

  # Read optional description from stdin or spec file
  TRIVIAL_DESC=""
  if [[ -n "$SPEC_FILE" && -f "$SPEC_FILE" ]]; then
    TRIVIAL_DESC=$(cat "$SPEC_FILE")
  elif [[ ! -t 0 ]]; then
    TRIVIAL_DESC=$(cat)
  fi

  # Parse WORKFLOW for project_slug
  FRONTMATTER=$(sed -n '/^---$/,/^---$/p' "$WORKFLOW_PATH" | sed '1d;$d')
  PROJECT_SLUG=$(echo "$FRONTMATTER" | grep 'project_slug:' | head -1 | sed 's/.*project_slug:[[:space:]]*//' | tr -d '"'"'" | xargs)

  if [[ -z "$PROJECT_SLUG" ]]; then
    echo "ERROR: No project_slug found in WORKFLOW file: $WORKFLOW_PATH" >&2
    exit 1
  fi

  echo "=== freeze-and-queue.sh (trivial) ==="
  echo "Title: $TRIVIAL_TITLE"
  echo "WORKFLOW: $WORKFLOW_PATH"
  echo "Project slug: $PROJECT_SLUG"
  echo "Dry run: $DRY_RUN"

  if [[ "$DRY_RUN" == true ]]; then
    echo ""
    echo "--- TRIVIAL ISSUE ---"
    echo "Title: $TRIVIAL_TITLE"
    echo "State: Todo"
    echo "Description: ${TRIVIAL_DESC:-(none)}"
    echo ""
    echo "=== Dry run complete: 1 trivial issue would be created ==="
    exit 0
  fi

  # Resolve team from project
  LINEAR_CLI="linear-cli"
  resolve_team_from_project

  # Resolve all states in one batch query
  resolve_all_states
  TODO_STATE_NAME="Todo"
  if [[ -z "$TODO_STATE_ID" ]]; then
    echo "WARNING: 'Todo' state not found. Falling back to 'Backlog'..." >&2
    TODO_STATE_ID="$BACKLOG_STATE_ID"
    TODO_STATE_NAME="Backlog"
  fi

  # Create issue via GraphQL — includes projectId and stateId at creation time
  TRIVIAL_GQL_TMPFILE=$(mktemp)
  trap 'rm -f "$TRIVIAL_GQL_TMPFILE"' EXIT
  if [[ -n "$TRIVIAL_DESC" ]]; then
    cat > "$TRIVIAL_GQL_TMPFILE" <<'GQLEOF'
mutation($title: String!, $description: String, $teamId: String!, $stateId: String!, $projectId: String!) {
  issueCreate(input: {
    teamId: $teamId
    title: $title
    description: $description
    stateId: $stateId
    projectId: $projectId
  }) {
    success
    issue { id identifier url }
  }
}
GQLEOF
    result=$($LINEAR_CLI api query -o json --quiet --compact \
      -v "title=$TRIVIAL_TITLE" \
      -v "description=$TRIVIAL_DESC" \
      -v "teamId=$TEAM_ID" \
      -v "stateId=$TODO_STATE_ID" \
      -v "projectId=$PROJECT_ID" \
      - < "$TRIVIAL_GQL_TMPFILE" 2>&1)
  else
    cat > "$TRIVIAL_GQL_TMPFILE" <<'GQLEOF'
mutation($title: String!, $teamId: String!, $stateId: String!, $projectId: String!) {
  issueCreate(input: {
    teamId: $teamId
    title: $title
    stateId: $stateId
    projectId: $projectId
  }) {
    success
    issue { id identifier url }
  }
}
GQLEOF
    result=$($LINEAR_CLI api query -o json --quiet --compact \
      -v "title=$TRIVIAL_TITLE" \
      -v "teamId=$TEAM_ID" \
      -v "stateId=$TODO_STATE_ID" \
      -v "projectId=$PROJECT_ID" \
      - < "$TRIVIAL_GQL_TMPFILE" 2>&1)
  fi
  rm -f "$TRIVIAL_GQL_TMPFILE"

  identifier=$(echo "$result" | jq -r '.data.issueCreate.issue.identifier // empty')
  url=$(echo "$result" | jq -r '.data.issueCreate.issue.url // empty')
  issue_id=$(echo "$result" | jq -r '.data.issueCreate.issue.id // empty')
  success=$(echo "$result" | jq -r '.data.issueCreate.success // false')

  if [[ "$success" == "true" && -n "$identifier" ]]; then
    echo ""
    echo "=== Done (trivial) ==="
    echo "Issue: $identifier ($url)"
    echo "State: $TODO_STATE_NAME"
    echo ""
    echo "Symphony-ts will pick up this issue automatically when the pipeline runs."
  else
    echo "FAILED to create trivial issue" >&2
    echo "Response: $result" >&2
    exit 1
  fi
  exit 0
fi

# ── Read spec content ────────────────────────────────────────────────────────

if [[ -n "$SPEC_FILE" ]]; then
  if [[ ! -f "$SPEC_FILE" ]]; then
    echo "ERROR: Spec file not found: $SPEC_FILE" >&2
    exit 1
  fi
  SPEC_CONTENT=$(cat "$SPEC_FILE")
elif [[ ! -t 0 ]]; then
  SPEC_CONTENT=$(cat)
else
  echo "ERROR: No spec file provided and stdin is a terminal." >&2
  echo "  Provide a spec file or pipe spec content to stdin." >&2
  exit 1
fi

if [[ -z "$SPEC_CONTENT" ]]; then
  echo "ERROR: Spec content is empty." >&2
  exit 1
fi

# ── Parse WORKFLOW config ────────────────────────────────────────────────────

# Extract YAML frontmatter between --- markers
FRONTMATTER=$(sed -n '/^---$/,/^---$/p' "$WORKFLOW_PATH" | sed '1d;$d')

# Extract project_slug from frontmatter
PROJECT_SLUG=$(echo "$FRONTMATTER" | grep 'project_slug:' | head -1 | sed 's/.*project_slug:[[:space:]]*//' | tr -d '"'"'" | xargs)

if [[ -z "$PROJECT_SLUG" ]]; then
  echo "ERROR: No project_slug found in WORKFLOW file: $WORKFLOW_PATH" >&2
  exit 1
fi

echo "=== freeze-and-queue.sh ==="
echo "WORKFLOW: $WORKFLOW_PATH"
echo "Project slug: $PROJECT_SLUG"
echo "Dry run: $DRY_RUN"
echo "Parent only: $PARENT_ONLY"
[[ -n "$UPDATE_ISSUE_ID" ]] && echo "Update mode: $UPDATE_ISSUE_ID"

# ── Linear CLI helpers ───────────────────────────────────────────────────────
# All Linear operations use linear-cli, which handles auth (OAuth or API key).
# Pass --api-key via LINEAR_API_KEY env var if needed (linear-cli reads it).

LINEAR_CLI="linear-cli"

# ── Resolve team from project ────────────────────────────────────────────────

resolve_team_from_project() {
  # Single GraphQL query to resolve both project ID and team info from slugId
  local project_json
  project_json=$($LINEAR_CLI api query -o json --quiet --compact \
    -v "slug=$PROJECT_SLUG" \
    'query($slug: String!) { projects(filter: { slugId: { eq: $slug } }) { nodes { id teams { nodes { id key } } } } }' 2>/dev/null)

  PROJECT_ID=$(echo "$project_json" | jq -r '.data.projects.nodes[0].id // empty')
  if [[ -z "$PROJECT_ID" ]]; then
    echo "ERROR: Could not find project with slugId: $PROJECT_SLUG" >&2
    echo "  Ensure the project exists and linear-cli is authenticated." >&2
    exit 1
  fi
  echo "Project ID: $PROJECT_ID"

  TEAM_ID=$(echo "$project_json" | jq -r '.data.projects.nodes[0].teams.nodes[0].id // empty')
  TEAM_KEY=$(echo "$project_json" | jq -r '.data.projects.nodes[0].teams.nodes[0].key // empty')

  if [[ -z "$TEAM_ID" ]]; then
    echo "ERROR: Could not resolve team from project: $PROJECT_ID" >&2
    echo "  API response: $project_json" >&2
    exit 1
  fi
  echo "Resolved team: $TEAM_KEY (ID: $TEAM_ID)"
}

# ── Resolve workflow state IDs for the team ──────────────────────────────────
# Globals populated by resolve_all_states():
DRAFT_STATE_ID=""
TODO_STATE_ID=""
BACKLOG_STATE_ID=""

resolve_all_states() {
  # Single workflowStates GraphQL query to batch-resolve all needed state IDs
  local states_json
  states_json=$($LINEAR_CLI api query -o json --quiet --compact \
    -v "teamId=$TEAM_ID" \
    'query($teamId: String!) { workflowStates(filter: { team: { id: { eq: $teamId } } }) { nodes { id name } } }' 2>/dev/null)

  DRAFT_STATE_ID=$(echo "$states_json" | jq -r '.data.workflowStates.nodes[] | select(.name == "Draft") | .id' | head -1)
  TODO_STATE_ID=$(echo "$states_json" | jq -r '.data.workflowStates.nodes[] | select(.name == "Todo") | .id' | head -1)
  BACKLOG_STATE_ID=$(echo "$states_json" | jq -r '.data.workflowStates.nodes[] | select(.name == "Backlog") | .id' | head -1)
}

# ── Parse tasks from spec content ────────────────────────────────────────────

# Extract title from first # heading
SPEC_TITLE=$(echo "$SPEC_CONTENT" | grep -m1 '^# ' | sed 's/^# //')
if [[ -z "$SPEC_TITLE" ]]; then
  SPEC_TITLE="Spec $(date +%Y-%m-%d)"
fi

# Parse ## Task N: headers and collect each task's content
declare -a TASK_TITLES TASK_BODIES TASK_SCOPES
task_idx=-1
current_body=""
current_scope=""

while IFS= read -r line; do
  if [[ "$line" =~ ^#{2,3}\ Task\ [0-9]+:\ (.+)$ ]] || [[ "$line" =~ ^#{2,3}\ Task\ [0-9]+\ -\ (.+)$ ]] || [[ "$line" =~ ^#{2,3}\ Task\ [0-9]+\.\ (.+)$ ]]; then
    # Save previous task
    if [[ $task_idx -ge 0 ]]; then
      TASK_BODIES[$task_idx]="$current_body"
      TASK_SCOPES[$task_idx]="$current_scope"
    fi
    ((task_idx++))
    TASK_TITLES[$task_idx]="${BASH_REMATCH[1]}"
    current_body=""
    current_scope=""
  elif [[ $task_idx -ge 0 ]]; then
    # Accumulate body lines
    current_body+="$line"$'\n'
    # Extract scope from **Scope**: lines
    if [[ "$line" =~ ^\*\*Scope\*\*:\ (.+)$ ]]; then
      current_scope="${BASH_REMATCH[1]}"
    fi
  fi
done <<< "$SPEC_CONTENT"

# Save last task
if [[ $task_idx -ge 0 ]]; then
  TASK_BODIES[$task_idx]="$current_body"
  TASK_SCOPES[$task_idx]="$current_scope"
fi

TOTAL=$((task_idx + 1))
echo ""
echo "Spec title: $SPEC_TITLE"
echo "Found $TOTAL tasks"

if [[ $TOTAL -eq 0 ]]; then
  echo "WARNING: No tasks found. Expected ## Task N: headers in spec content." >&2
  echo "Parent issue will be created without sub-issues." >&2
fi

# ── Detect file-path overlap for blockedBy relations ─────────────────────────

detect_overlap() {
  local scope_a="$1" scope_b="$2"
  [[ -z "$scope_a" || -z "$scope_b" ]] && return 1
  IFS=', ' read -ra files_a <<< "$scope_a"
  IFS=', ' read -ra files_b <<< "$scope_b"
  for fa in "${files_a[@]}"; do
    for fb in "${files_b[@]}"; do
      fa_clean=$(echo "$fa" | sed 's/`//g' | xargs)
      fb_clean=$(echo "$fb" | sed 's/`//g' | xargs)
      [[ -z "$fa_clean" || -z "$fb_clean" ]] && continue
      if [[ "$fa_clean" == "$fb_clean" ]] || \
         [[ "$fa_clean" == "$fb_clean"/* ]] || \
         [[ "$fb_clean" == "$fa_clean"/* ]]; then
        return 0
      fi
    done
  done
  return 1
}

# ── Parse task priorities for sequential ordering ────────────────────────────

declare -a TASK_PRIORITIES
for ((i=0; i<TOTAL; i++)); do
  pri=$(echo "${TASK_BODIES[$i]}" | grep -oE '\*\*Priority\*\*:[[:space:]]*[0-9]+' | grep -oE '[0-9]+' | head -1)
  TASK_PRIORITIES[$i]="${pri:-$((i+1))}"
done

# Build priority-sorted index array (stable sort by priority, preserving task order for ties)
SORTED_INDICES=()
for ((i=0; i<TOTAL; i++)); do
  SORTED_INDICES+=("$i")
done

# Bubble sort by priority (stable — preserves original order for equal priorities)
for ((i=0; i<TOTAL; i++)); do
  for ((j=0; j<TOTAL-i-1; j++)); do
    idx_a="${SORTED_INDICES[$j]}"
    idx_b="${SORTED_INDICES[$((j+1))]}"
    if (( TASK_PRIORITIES[idx_a] > TASK_PRIORITIES[idx_b] )); then
      SORTED_INDICES[$j]="$idx_b"
      SORTED_INDICES[$((j+1))]="$idx_a"
    fi
  done
done

# ── Parse Scenarios section from parent spec ─────────────────────────────────

# Extract the full Scenarios section (from "## Scenarios" until the next ## heading)
SCENARIOS_SECTION=""
in_scenarios=false
while IFS= read -r line; do
  if [[ "$line" =~ ^##\ Scenarios ]]; then
    in_scenarios=true
    continue
  elif [[ "$in_scenarios" == true && "$line" =~ ^##\  && ! "$line" =~ ^###\  ]]; then
    break
  fi
  if [[ "$in_scenarios" == true ]]; then
    SCENARIOS_SECTION+="$line"$'\n'
  fi
done <<< "$SPEC_CONTENT"

# Parse individual scenarios from the Scenarios section
# Each scenario starts with "Scenario:" (possibly inside a gherkin block) and ends
# before the next "Scenario:" or the end of the section.
declare -a SCENARIO_NAMES SCENARIO_BODIES
scenario_idx=-1
current_scenario_body=""
current_scenario_name=""

while IFS= read -r line; do
  if [[ "$line" =~ ^[[:space:]]*Scenario:[[:space:]]*(.+)$ ]]; then
    # Save previous scenario
    if [[ $scenario_idx -ge 0 ]]; then
      SCENARIO_BODIES[$scenario_idx]="$current_scenario_body"
    fi
    ((scenario_idx++))
    current_scenario_name="${BASH_REMATCH[1]}"
    SCENARIO_NAMES[$scenario_idx]="$current_scenario_name"
    current_scenario_body="$line"$'\n'
  elif [[ $scenario_idx -ge 0 ]]; then
    # Skip gherkin code fence markers (``` lines)
    if [[ "$line" =~ ^[[:space:]]*\`\`\` ]]; then
      continue
    fi
    current_scenario_body+="$line"$'\n'
  fi
done <<< "$SCENARIOS_SECTION"

# Save last scenario
if [[ $scenario_idx -ge 0 ]]; then
  SCENARIO_BODIES[$scenario_idx]="$current_scenario_body"
fi

TOTAL_SCENARIOS=$((scenario_idx + 1))
echo "Found $TOTAL_SCENARIOS scenarios in spec"

# ── Parse Boundaries section from parent spec ────────────────────────────────

BOUNDARIES_SECTION=""
in_boundaries=false
while IFS= read -r line; do
  if [[ "$line" =~ ^##\ Boundaries ]]; then
    in_boundaries=true
    BOUNDARIES_SECTION+="## Boundaries"$'\n'
    continue
  elif [[ "$in_boundaries" == true && "$line" =~ ^##\  && ! "$line" =~ ^###\  ]]; then
    break
  fi
  if [[ "$in_boundaries" == true ]]; then
    BOUNDARIES_SECTION+="$line"$'\n'
  fi
done <<< "$SPEC_CONTENT"

# ── Parse task scenario references ───────────────────────────────────────────

declare -a TASK_SCENARIO_REFS
for ((i=0; i<TOTAL; i++)); do
  ref=$(echo "${TASK_BODIES[$i]}" | grep -oE '\*\*Scenarios\*\*:[[:space:]]*(.+)' | sed 's/\*\*Scenarios\*\*:[[:space:]]*//' | head -1)
  TASK_SCENARIO_REFS[$i]="${ref:-}"
done

# ── Build sub-issue bodies with inlined Gherkin + verify lines ───────────────

match_scenario_to_task() {
  local scenario_name="$1"
  local task_ref="$2"

  # "All" matches everything
  if [[ "$task_ref" == "All" || "$task_ref" == "all" ]]; then
    return 0
  fi

  # Check if the scenario name appears in the comma-separated task ref list
  IFS=',' read -ra refs <<< "$task_ref"
  for ref in "${refs[@]}"; do
    ref_clean=$(echo "$ref" | xargs)  # trim whitespace
    if [[ "$scenario_name" == *"$ref_clean"* || "$ref_clean" == *"$scenario_name"* ]]; then
      return 0
    fi
  done
  return 1
}

build_sub_issue_body() {
  local idx=$1
  local body="${TASK_BODIES[$idx]}"
  local task_ref="${TASK_SCENARIO_REFS[$idx]:-}"

  local output=""
  output+="## Task Scope"$'\n'
  output+="$body"$'\n'

  # Add matched scenarios
  if [[ -n "$task_ref" && $TOTAL_SCENARIOS -gt 0 ]]; then
    output+="## Scenarios"$'\n'$'\n'
    local matched=0
    for ((s=0; s<TOTAL_SCENARIOS; s++)); do
      if match_scenario_to_task "${SCENARIO_NAMES[$s]}" "$task_ref"; then
        output+="${SCENARIO_BODIES[$s]}"$'\n'
        ((matched++))
      fi
    done
    if [[ $matched -eq 0 ]]; then
      output+="_No matching scenarios found for: ${task_ref}_"$'\n'
    fi
    output+=$'\n'
  fi

  # Add boundaries section
  if [[ -n "$BOUNDARIES_SECTION" ]]; then
    output+="$BOUNDARIES_SECTION"$'\n'
  fi

  output+="---"$'\n'
  output+="_Created by freeze-and-queue.sh from parent spec. Implement exactly what is specified._"
  echo "$output"
}

# ── Execute: Create or update parent, create sub-issues ──────────────────────

if [[ "$DRY_RUN" == true ]]; then
  echo ""
  echo "═══════════════════════════════════════════════════════════════"
  echo "  DRY RUN — No Linear API calls will be made"
  echo "═══════════════════════════════════════════════════════════════"
  echo ""

  echo "--- PARENT ISSUE ---"
  echo "Title: [Spec] $SPEC_TITLE"
  echo "State: Draft (fallback: Backlog)"
  echo "Description: (full spec content, ${#SPEC_CONTENT} chars)"
  echo ""

  if [[ "$PARENT_ONLY" == true ]]; then
    echo "=== Dry run complete (--parent-only): 1 parent issue would be created ==="
    exit 0
  fi

  for ((i=0; i<TOTAL; i++)); do
    echo "--- SUB-ISSUE $((i+1)): ${TASK_TITLES[$i]} ---"
    echo "Priority: ${TASK_PRIORITIES[$i]}"
    echo "Scope: ${TASK_SCOPES[$i]:-<none>}"
    echo "Scenarios ref: ${TASK_SCENARIO_REFS[$i]:-<none>}"
    sub_body=$(build_sub_issue_body "$i")
    echo "Body preview (first 10 lines):"
    echo "$sub_body" | head -10 | sed 's/^/  /'
    echo "  ..."
    echo ""
  done

  # Show blockedBy relations
  echo "--- BLOCKED-BY RELATIONS ---"
  relation_count=0

  # Sequential chain based on priority ordering
  echo "  Sequential (priority order):"
  for ((k=0; k<TOTAL-1; k++)); do
    blocker_idx="${SORTED_INDICES[$k]}"
    blocked_idx="${SORTED_INDICES[$((k+1))]}"
    echo "    Task $((blocked_idx+1)) (${TASK_TITLES[$blocked_idx]}) blocked by Task $((blocker_idx+1)) (${TASK_TITLES[$blocker_idx]})"
    ((relation_count++))
  done
  [[ $TOTAL -le 1 ]] && echo "    (none — single task)"

  # Additional file-overlap relations (only those not already covered by sequential chain)
  echo "  File-overlap (additional):"
  overlap_count=0
  for ((i=0; i<TOTAL; i++)); do
    for ((j=i+1; j<TOTAL; j++)); do
      if detect_overlap "${TASK_SCOPES[$i]:-}" "${TASK_SCOPES[$j]:-}"; then
        # Check if this pair is already covered by sequential chain
        already_covered=false
        for ((k=0; k<TOTAL-1; k++)); do
          si="${SORTED_INDICES[$k]}"
          si_next="${SORTED_INDICES[$((k+1))]}"
          if [[ "$si" == "$i" && "$si_next" == "$j" ]] || [[ "$si" == "$j" && "$si_next" == "$i" ]]; then
            already_covered=true
            break
          fi
        done
        if [[ "$already_covered" == false ]]; then
          echo "    Task $((j+1)) (${TASK_TITLES[$j]}) blocked by Task $((i+1)) (${TASK_TITLES[$i]}) (file overlap)"
          ((relation_count++)) || true
          ((overlap_count++)) || true
        fi
      fi
    done
  done
  [[ $overlap_count -eq 0 ]] && echo "    (none)"

  echo ""
  echo "=== Dry run complete: 1 parent + $TOTAL sub-issues + $relation_count relations would be created ==="
  exit 0
fi

# ── Live mode: resolve Linear config ─────────────────────────────────────────

resolve_team_from_project

# Resolve all workflow states in a single batch query
resolve_all_states

# Parent issue → Draft state (fallback to Backlog)
DRAFT_STATE_NAME=""
if [[ -n "$DRAFT_STATE_ID" ]]; then
  DRAFT_STATE_NAME="Draft"
elif [[ -n "$BACKLOG_STATE_ID" ]]; then
  DRAFT_STATE_ID="$BACKLOG_STATE_ID"
  DRAFT_STATE_NAME="Backlog"
  echo "WARNING: 'Draft' state not found for team. Falling back to 'Backlog'..." >&2
else
  echo "WARNING: Neither 'Draft' nor 'Backlog' state found. Parent issue will use default state." >&2
fi
echo "Draft state: ${DRAFT_STATE_NAME:-<default>} (ID: ${DRAFT_STATE_ID:-<default>})"

# Sub-issues → Todo state (fallback to Backlog)
TODO_STATE_NAME=""
if [[ -n "$TODO_STATE_ID" ]]; then
  TODO_STATE_NAME="Todo"
elif [[ -n "$BACKLOG_STATE_ID" ]]; then
  TODO_STATE_ID="$BACKLOG_STATE_ID"
  TODO_STATE_NAME="Backlog"
  echo "WARNING: 'Todo' state not found for team. Falling back to 'Backlog'..." >&2
else
  echo "WARNING: Neither 'Todo' nor 'Backlog' state found. Sub-issues will use default state." >&2
fi
echo "Todo state: ${TODO_STATE_NAME:-<default>} (ID: ${TODO_STATE_ID:-<default>})"

# ── Create or update parent issue ────────────────────────────────────────────

# Write spec content to temp file for stdin piping (avoids arg length limits)
SPEC_TMPFILE=$(mktemp)
GQL_TMPFILE=""
trap 'rm -f "$SPEC_TMPFILE" ${GQL_TMPFILE:+"$GQL_TMPFILE"}' EXIT
echo "$SPEC_CONTENT" > "$SPEC_TMPFILE"

if [[ -n "$UPDATE_ISSUE_ID" ]]; then
  echo ""
  echo "Updating existing parent issue: $UPDATE_ISSUE_ID"

  # Build issueUpdate mutation via temp file (title/description are user-provided strings)
  GQL_TMPFILE=$(mktemp)
  if [[ -n "$DRAFT_STATE_ID" ]]; then
    cat > "$GQL_TMPFILE" <<'GQLEOF'
mutation($issueId: String!, $title: String!, $description: String!, $stateId: String!) {
  issueUpdate(id: $issueId, input: {
    title: $title
    description: $description
    stateId: $stateId
  }) {
    success
    issue { id identifier url }
  }
}
GQLEOF
    result=$($LINEAR_CLI api query -o json --quiet --compact \
      -v "issueId=$UPDATE_ISSUE_ID" \
      -v "title=[Spec] $SPEC_TITLE" \
      -v "description=$(cat "$SPEC_TMPFILE")" \
      -v "stateId=$DRAFT_STATE_ID" \
      - < "$GQL_TMPFILE" 2>&1)
  else
    cat > "$GQL_TMPFILE" <<'GQLEOF'
mutation($issueId: String!, $title: String!, $description: String!) {
  issueUpdate(id: $issueId, input: {
    title: $title
    description: $description
  }) {
    success
    issue { id identifier url }
  }
}
GQLEOF
    result=$($LINEAR_CLI api query -o json --quiet --compact \
      -v "issueId=$UPDATE_ISSUE_ID" \
      -v "title=[Spec] $SPEC_TITLE" \
      -v "description=$(cat "$SPEC_TMPFILE")" \
      - < "$GQL_TMPFILE" 2>&1)
  fi
  rm -f "$GQL_TMPFILE"; GQL_TMPFILE=""

  success=$(echo "$result" | jq -r '.data.issueUpdate.success // false')
  PARENT_ID=$(echo "$result" | jq -r '.data.issueUpdate.issue.id // empty')
  parent_identifier=$(echo "$result" | jq -r '.data.issueUpdate.issue.identifier // empty')
  parent_url=$(echo "$result" | jq -r '.data.issueUpdate.issue.url // empty')
  PARENT_IDENTIFIER="$parent_identifier"

  if [[ "$success" == "true" && -n "$parent_identifier" ]]; then
    echo "  Updated: $parent_identifier ($parent_url)"
  else
    echo "  FAILED to update parent issue" >&2
    echo "  Response: $result" >&2
    exit 1
  fi
else
  echo ""
  echo "Creating parent issue..."

  # Spec parent: issueCreate mutation via temp file (title/description are user-provided strings)
  # Includes projectId at creation time (eliminates separate issues update --project call)
  GQL_TMPFILE=$(mktemp)
  if [[ -n "$DRAFT_STATE_ID" ]]; then
    cat > "$GQL_TMPFILE" <<'GQLEOF'
mutation($title: String!, $description: String!, $teamId: String!, $projectId: String!, $stateId: String!) {
  issueCreate(input: {
    title: $title
    description: $description
    teamId: $teamId
    projectId: $projectId
    stateId: $stateId
  }) {
    success
    issue { id identifier url }
  }
}
GQLEOF
    result=$($LINEAR_CLI api query -o json --quiet --compact \
      -v "title=[Spec] $SPEC_TITLE" \
      -v "description=$(cat "$SPEC_TMPFILE")" \
      -v "teamId=$TEAM_ID" \
      -v "projectId=$PROJECT_ID" \
      -v "stateId=$DRAFT_STATE_ID" \
      - < "$GQL_TMPFILE" 2>&1)
  else
    cat > "$GQL_TMPFILE" <<'GQLEOF'
mutation($title: String!, $description: String!, $teamId: String!, $projectId: String!) {
  issueCreate(input: {
    title: $title
    description: $description
    teamId: $teamId
    projectId: $projectId
  }) {
    success
    issue { id identifier url }
  }
}
GQLEOF
    result=$($LINEAR_CLI api query -o json --quiet --compact \
      -v "title=[Spec] $SPEC_TITLE" \
      -v "description=$(cat "$SPEC_TMPFILE")" \
      -v "teamId=$TEAM_ID" \
      -v "projectId=$PROJECT_ID" \
      - < "$GQL_TMPFILE" 2>&1)
  fi
  rm -f "$GQL_TMPFILE"; GQL_TMPFILE=""

  success=$(echo "$result" | jq -r '.data.issueCreate.success // false')
  PARENT_ID=$(echo "$result" | jq -r '.data.issueCreate.issue.id // empty')
  parent_identifier=$(echo "$result" | jq -r '.data.issueCreate.issue.identifier // empty')
  parent_url=$(echo "$result" | jq -r '.data.issueCreate.issue.url // empty')
  PARENT_IDENTIFIER="$parent_identifier"

  if [[ "$success" == "true" && -n "$parent_identifier" && -n "$PARENT_ID" ]]; then
    echo "  Created parent: $parent_identifier ($parent_url)"
  else
    echo "  FAILED to create parent issue" >&2
    echo "  Response: $result" >&2
    exit 1
  fi
fi

# ── Parent-only mode: exit after parent creation ─────────────────────────────

if [[ "$PARENT_ONLY" == true ]]; then
  echo ""
  echo "=== Done (--parent-only) ==="
  echo "Parent: $PARENT_IDENTIFIER ($parent_url)"
  echo ""
  echo "Run again without --parent-only (with --update $PARENT_IDENTIFIER) to create sub-issues."
  exit 0
fi

# ── Create sub-issues ────────────────────────────────────────────────────────

declare -a SUB_ISSUE_IDS SUB_ISSUE_IDENTIFIERS
echo ""
echo "Creating $TOTAL sub-issues..."

for ((i=0; i<TOTAL; i++)); do
  title="${TASK_TITLES[$i]}"
  sub_body=$(build_sub_issue_body "$i")

  # Extract priority if present
  pri_num=$(echo "${TASK_BODIES[$i]}" | grep -oE '\*\*Priority\*\*:[[:space:]]*[0-9]+' | grep -oE '[0-9]+' | head -1)
  linear_priority=${pri_num:-3}

  # Write sub-issue body to temp file for description
  echo "$sub_body" > "$SPEC_TMPFILE"

  # Build sub-issue issueCreate mutation via temp file (title/description are user-provided strings)
  # Includes both projectId and parentId at creation time — no separate API calls needed.
  # Priority is inlined as integer literal to avoid Int/String type coercion issues with -v flag.
  GQL_TMPFILE=$(mktemp)
  if [[ -n "$TODO_STATE_ID" ]]; then
    cat > "$GQL_TMPFILE" <<GQLEOF
mutation(\$title: String!, \$description: String!, \$teamId: String!, \$projectId: String!, \$parentId: String!, \$stateId: String!) {
  issueCreate(input: {
    title: \$title
    description: \$description
    teamId: \$teamId
    projectId: \$projectId
    parentId: \$parentId
    stateId: \$stateId
    priority: ${linear_priority}
  }) {
    success
    issue { id identifier url }
  }
}
GQLEOF
    result=$($LINEAR_CLI api query -o json --quiet --compact \
      -v "title=$title" \
      -v "description=$(cat "$SPEC_TMPFILE")" \
      -v "teamId=$TEAM_ID" \
      -v "projectId=$PROJECT_ID" \
      -v "parentId=$PARENT_ID" \
      -v "stateId=$TODO_STATE_ID" \
      - < "$GQL_TMPFILE" 2>&1)
  else
    cat > "$GQL_TMPFILE" <<GQLEOF
mutation(\$title: String!, \$description: String!, \$teamId: String!, \$projectId: String!, \$parentId: String!) {
  issueCreate(input: {
    title: \$title
    description: \$description
    teamId: \$teamId
    projectId: \$projectId
    parentId: \$parentId
    priority: ${linear_priority}
  }) {
    success
    issue { id identifier url }
  }
}
GQLEOF
    result=$($LINEAR_CLI api query -o json --quiet --compact \
      -v "title=$title" \
      -v "description=$(cat "$SPEC_TMPFILE")" \
      -v "teamId=$TEAM_ID" \
      -v "projectId=$PROJECT_ID" \
      -v "parentId=$PARENT_ID" \
      - < "$GQL_TMPFILE" 2>&1)
  fi
  rm -f "$GQL_TMPFILE"; GQL_TMPFILE=""

  success=$(echo "$result" | jq -r '.data.issueCreate.success // false')
  sub_identifier=$(echo "$result" | jq -r '.data.issueCreate.issue.identifier // empty')
  sub_url=$(echo "$result" | jq -r '.data.issueCreate.issue.url // empty')
  sub_id=$(echo "$result" | jq -r '.data.issueCreate.issue.id // empty')

  if [[ "$success" == "true" && -n "$sub_identifier" && -n "$sub_id" ]]; then
    echo "  Created: $sub_identifier — $title ($sub_url)"
    SUB_ISSUE_IDS[$i]="$sub_id"
    SUB_ISSUE_IDENTIFIERS[$i]="$sub_identifier"
  else
    echo "  FAILED: $title" >&2
    echo "  Response: $result" >&2
    SUB_ISSUE_IDS[$i]=""
    SUB_ISSUE_IDENTIFIERS[$i]=""
  fi
done

# ── Create blockedBy relations ───────────────────────────────────────────────

echo ""
echo "Creating blockedBy relations..."
relation_count=0

# Track created relations to avoid duplicates (bash 3.2 compatible — no associative arrays)
CREATED_RELATIONS=""

# Helper: create a blockedBy relation via GraphQL mutation.
# linear-cli relations add is broken (claims success but relations don't persist).
# Uses issueRelationCreate mutation via temp file to avoid shell escaping issues
# with String! types that linear-cli api query auto-escapes.
# Args: $1=blocker_uuid $2=blocked_uuid $3=blocker_ident $4=blocked_ident $5=reason
create_blocks_relation() {
  local blocker_uuid="$1" blocked_uuid="$2"
  local blocker_ident="$3" blocked_ident="$4" reason="$5"

  # issueId=BLOCKER, relatedIssueId=BLOCKED, type=blocks
  # means: issueId blocks relatedIssueId
  local gql_tmpfile
  gql_tmpfile=$(mktemp)
  cat > "$gql_tmpfile" <<GQLEOF
mutation { issueRelationCreate(input: { issueId: "${blocker_uuid}", relatedIssueId: "${blocked_uuid}", type: blocks }) { issueRelation { id } } }
GQLEOF

  local result
  if result=$($LINEAR_CLI api query -o json --quiet --compact - < "$gql_tmpfile" 2>&1); then
    local rel_id
    rel_id=$(echo "$result" | jq -r '.data.issueRelationCreate.issueRelation.id // empty')
    if [[ -n "$rel_id" ]]; then
      echo "  $blocked_ident blocked by $blocker_ident ($reason)"
      rm -f "$gql_tmpfile"
      return 0
    fi
  fi
  echo "  WARNING: Failed to create relation $blocker_ident blocks $blocked_ident" >&2
  echo "  Response: ${result:-<empty>}" >&2
  rm -f "$gql_tmpfile"
  return 1
}

# 1. Sequential chain based on priority ordering
for ((k=0; k<TOTAL-1; k++)); do
  blocker_idx="${SORTED_INDICES[$k]}"
  blocked_idx="${SORTED_INDICES[$((k+1))]}"
  blocker_id="${SUB_ISSUE_IDS[$blocker_idx]:-}"
  blocked_id="${SUB_ISSUE_IDS[$blocked_idx]:-}"
  blocker="${SUB_ISSUE_IDENTIFIERS[$blocker_idx]:-}"
  blocked="${SUB_ISSUE_IDENTIFIERS[$blocked_idx]:-}"

  if [[ -n "$blocker_id" && -n "$blocked_id" ]]; then
    relation_key="${blocker}:${blocked}"
    if create_blocks_relation "$blocker_id" "$blocked_id" "$blocker" "$blocked" "sequential"; then
      CREATED_RELATIONS="${CREATED_RELATIONS}|${relation_key}"
      ((relation_count++))
    fi
  fi
done

# 2. Additional file-overlap relations (only those not already covered)
for ((i=0; i<TOTAL; i++)); do
  for ((j=i+1; j<TOTAL; j++)); do
    if detect_overlap "${TASK_SCOPES[$i]:-}" "${TASK_SCOPES[$j]:-}"; then
      blocker_id="${SUB_ISSUE_IDS[$i]:-}"
      blocked_id="${SUB_ISSUE_IDS[$j]:-}"
      blocker="${SUB_ISSUE_IDENTIFIERS[$i]:-}"
      blocked="${SUB_ISSUE_IDENTIFIERS[$j]:-}"

      if [[ -n "$blocker_id" && -n "$blocked_id" ]]; then
        relation_key="${blocker}:${blocked}"
        if [[ "$CREATED_RELATIONS" != *"|${relation_key}"* ]]; then
          if create_blocks_relation "$blocker_id" "$blocked_id" "$blocker" "$blocked" "file overlap"; then
            CREATED_RELATIONS="${CREATED_RELATIONS}|${relation_key}"
            ((relation_count++))
          fi
        fi
      fi
    fi
  done
done

[[ $relation_count -eq 0 ]] && echo "  (none)"

# ── Transition parent to Backlog (sub-issues now frozen) ─────────────────────
# Only reached when PARENT_ONLY=false (--parent-only exits at line 555)

echo ""
# Transition parent to Backlog via issueUpdate GraphQL mutation using stateId
GQL_TMPFILE=$(mktemp)
cat > "$GQL_TMPFILE" <<GQLEOF
mutation { issueUpdate(id: "${PARENT_ID}", input: { stateId: "${BACKLOG_STATE_ID}" }) { success issue { id } } }
GQLEOF
$LINEAR_CLI api query -o json --quiet --compact - < "$GQL_TMPFILE" > /dev/null 2>&1 || true
rm -f "$GQL_TMPFILE"; GQL_TMPFILE=""
echo "Parent $PARENT_IDENTIFIER transitioned to Backlog"

# ── Summary ──────────────────────────────────────────────────────────────────

echo ""
echo "=== Done ==="
echo "Parent: $PARENT_IDENTIFIER ($parent_url)"
echo "Sub-issues: $TOTAL created"
echo "Relations: $relation_count blockedBy relations"
echo ""
echo "Symphony-ts will pick up these issues automatically when the pipeline runs."
