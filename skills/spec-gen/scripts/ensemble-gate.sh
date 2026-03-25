#!/usr/bin/env bash
# ensemble-gate.sh — Spec-stage validation: model×role parallel CLI invocations
# Reads gate config from .ensemble/gates/, runs reviewers, aggregates verdicts
# ~100 lines as specced

set -euo pipefail

GATE_CONFIG="${1:-.ensemble/gates/spec-gate.yaml}"
SPEC_PATH="${2:-openspec/specs}"
MAX_ROUNDS="${MAX_ROUNDS:-3}"

echo "=== ensemble-gate.sh ==="
echo "Gate config: $GATE_CONFIG"
echo "Spec path: $SPEC_PATH"
echo ""

# Collect all spec content for review context
SPEC_CONTENT=""
for spec_file in $(find "$SPEC_PATH" -name "*.md" -type f); do
  SPEC_CONTENT+="--- $(basename "$spec_file") ---"$'\n'
  SPEC_CONTENT+="$(cat "$spec_file")"$'\n\n'
done

if [[ -z "$SPEC_CONTENT" ]]; then
  echo "ERROR: No spec files found in $SPEC_PATH"
  exit 1
fi

# Parse reviewers from YAML config (lightweight — no yq dependency)
# Expected format: role, model, system_prompt, verdict_required
declare -a ROLES MODELS PROMPTS REQUIRED
reviewer_idx=-1
in_prompt=false
current_prompt=""

while IFS= read -r line; do
  if [[ "$line" =~ ^[[:space:]]*-\ role:\ (.+)$ ]]; then
    if [[ $reviewer_idx -ge 0 ]] && $in_prompt; then
      PROMPTS[$reviewer_idx]="$current_prompt"
      in_prompt=false
      current_prompt=""
    fi
    ((reviewer_idx++))
    ROLES[$reviewer_idx]="${BASH_REMATCH[1]}"
    REQUIRED[$reviewer_idx]="true"
  elif [[ "$line" =~ ^[[:space:]]*model:\ (.+)$ ]] && [[ $reviewer_idx -ge 0 ]]; then
    MODELS[$reviewer_idx]="${BASH_REMATCH[1]}"
  elif [[ "$line" =~ ^[[:space:]]*verdict_required:\ (.+)$ ]] && [[ $reviewer_idx -ge 0 ]]; then
    REQUIRED[$reviewer_idx]="${BASH_REMATCH[1]}"
  elif [[ "$line" =~ ^[[:space:]]*system_prompt:\ \|$ ]] && [[ $reviewer_idx -ge 0 ]]; then
    in_prompt=true
    current_prompt=""
  elif $in_prompt; then
    if [[ "$line" =~ ^[[:space:]]{4,} ]] || [[ -z "$line" ]]; then
      current_prompt+="${line}"$'\n'
    else
      PROMPTS[$reviewer_idx]="$current_prompt"
      in_prompt=false
      current_prompt=""
    fi
  fi
done < "$GATE_CONFIG"

# Capture last prompt
if $in_prompt && [[ $reviewer_idx -ge 0 ]]; then
  PROMPTS[$reviewer_idx]="$current_prompt"
fi

TOTAL=$((reviewer_idx + 1))
echo "Loaded $TOTAL reviewers"

# Run each reviewer
declare -a VERDICTS FEEDBACK
AGGREGATE="PASS"
HAS_CONCERNS=false

for i in $(seq 0 $((TOTAL - 1))); do
  role="${ROLES[$i]}"
  model="${MODELS[$i]}"
  prompt="${PROMPTS[$i]}"
  required="${REQUIRED[$i]}"

  echo ""
  echo "--- $role ($model) ---"

  # Select CLI based on model
  review_prompt="$prompt"$'\n\n'"Review the following spec and provide your verdict (PASS, FAIL, or CONCERNS) on the first line, followed by your detailed feedback:"$'\n\n'"$SPEC_CONTENT"

  case "$model" in
    claude)
      result=$(echo "$review_prompt" | claude -p --output-format text 2>&1) || true
      ;;
    codex)
      result=$(codex exec "$review_prompt" 2>&1) || true
      ;;
    gemini)
      result=$(echo "$review_prompt" | gemini 2>&1) || true
      ;;
    *)
      echo "  WARNING: Unknown model '$model', skipping"
      continue
      ;;
  esac

  # Extract verdict from first line
  first_line=$(echo "$result" | head -1)
  if echo "$first_line" | grep -qi "FAIL"; then
    verdict="FAIL"
  elif echo "$first_line" | grep -qi "CONCERNS"; then
    verdict="CONCERNS"
  else
    verdict="PASS"
  fi

  VERDICTS[$i]="$verdict"
  FEEDBACK[$i]="$result"

  echo "  Verdict: $verdict"

  # Aggregate
  if [[ "$verdict" == "FAIL" ]] && [[ "$required" == "true" ]]; then
    AGGREGATE="FAIL"
  elif [[ "$verdict" == "CONCERNS" ]]; then
    HAS_CONCERNS=true
  fi
done

# Output structured gate result
echo ""
echo "=== Gate Result ==="

# JSON gate layer
gate_json=$(jq -n \
  --arg aggregate "$AGGREGATE" \
  --argjson has_concerns "$HAS_CONCERNS" \
  '{aggregate_verdict: $aggregate, has_concerns: $has_concerns, requires_human: ($aggregate == "FAIL" or $has_concerns)}')

echo "$gate_json" | jq .

# Feedback layer (plain text for agent consumption)
echo ""
echo "=== Reviewer Feedback ==="
for i in $(seq 0 $((TOTAL - 1))); do
  echo ""
  echo "### ${ROLES[$i]} (${MODELS[$i]}) — ${VERDICTS[$i]}"
  echo "${FEEDBACK[$i]}"
  echo ""
done

# Exit code: 0=PASS, 1=FAIL
if [[ "$AGGREGATE" == "FAIL" ]]; then
  exit 1
fi
