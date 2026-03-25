#!/usr/bin/env bash
set -euo pipefail

# Validation script for pipeline-config/WORKFLOW.md
# Checks that YAML frontmatter parses, referenced files exist, and scripts are executable.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKFLOW_FILE="$SCRIPT_DIR/WORKFLOW.md"
ERRORS=0

echo "=== Pipeline Config Validation ==="
echo ""

# --- 1. Check WORKFLOW.md exists ---
if [ ! -f "$WORKFLOW_FILE" ]; then
  echo "FAIL: WORKFLOW.md not found at $WORKFLOW_FILE"
  exit 1
fi
echo "OK: WORKFLOW.md found"

# --- 2. Extract and validate YAML frontmatter ---
# Extract content between first and second ---
YAML_CONTENT=$(awk '/^---$/{n++;next} n==1{print} n==2{exit}' "$WORKFLOW_FILE")

if [ -z "$YAML_CONTENT" ]; then
  echo "FAIL: No YAML frontmatter found (expected content between --- delimiters)"
  exit 1
fi

# Try parsing YAML — prefer node (yaml package available in symphony-ts)
SYMPHONY_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
NODE_PATH_PREFIX=""
if [ -d "$SYMPHONY_ROOT/node_modules" ]; then
  NODE_PATH_PREFIX="NODE_PATH=$SYMPHONY_ROOT/node_modules"
fi

if command -v node &>/dev/null && [ -n "$NODE_PATH_PREFIX" ]; then
  if ! echo "$YAML_CONTENT" | env $NODE_PATH_PREFIX node -e "
    const yaml = require('yaml');
    let data = '';
    process.stdin.on('data', c => data += c);
    process.stdin.on('end', () => { yaml.parse(data); });
  " 2>/dev/null; then
    echo "FAIL: YAML frontmatter failed to parse"
    ERRORS=$((ERRORS + 1))
  else
    echo "OK: YAML frontmatter parses successfully"
  fi
elif command -v python3 &>/dev/null; then
  if echo "$YAML_CONTENT" | python3 -c "import sys, yaml; yaml.safe_load(sys.stdin)" 2>/dev/null; then
    echo "OK: YAML frontmatter parses successfully"
  else
    echo "FAIL: YAML frontmatter failed to parse"
    ERRORS=$((ERRORS + 1))
  fi
else
  echo "WARN: Neither node nor python3 (with PyYAML) available — skipping YAML parse check"
fi

# --- 3. Check referenced prompt template files ---
echo ""
echo "--- Prompt Templates ---"

PROMPTS_DIR="$SCRIPT_DIR/prompts"
PROMPT_FILES=(
  "global.liquid"
  "investigate.liquid"
  "implement.liquid"
  "review-adversarial.liquid"
  "review-security.liquid"
  "merge.liquid"
)

# Also extract prompt file references from YAML
YAML_PROMPTS=$(echo "$YAML_CONTENT" | grep -oE 'prompts/[a-z-]+\.liquid' | sort -u)

for prompt in "${PROMPT_FILES[@]}"; do
  if [ -f "$PROMPTS_DIR/$prompt" ]; then
    echo "  OK: prompts/$prompt"
  else
    echo "  FAIL: prompts/$prompt not found"
    ERRORS=$((ERRORS + 1))
  fi
done

# Check any YAML-referenced prompts that aren't in our expected list
for yaml_prompt in $YAML_PROMPTS; do
  if [ -f "$SCRIPT_DIR/$yaml_prompt" ]; then
    echo "  OK: $yaml_prompt (referenced in YAML)"
  else
    echo "  FAIL: $yaml_prompt (referenced in YAML) not found"
    ERRORS=$((ERRORS + 1))
  fi
done

# --- 4. Check hook scripts exist and are executable ---
echo ""
echo "--- Hook Scripts ---"

HOOKS_DIR="$SCRIPT_DIR/hooks"
HOOK_FILES=(
  "after-create.sh"
  "before-run.sh"
)

for hook in "${HOOK_FILES[@]}"; do
  if [ ! -f "$HOOKS_DIR/$hook" ]; then
    echo "  FAIL: hooks/$hook not found"
    ERRORS=$((ERRORS + 1))
  elif [ ! -x "$HOOKS_DIR/$hook" ]; then
    echo "  FAIL: hooks/$hook exists but is not executable"
    ERRORS=$((ERRORS + 1))
  else
    echo "  OK: hooks/$hook (executable)"
  fi
done

# --- 5. Summarize stages and transitions ---
echo ""
echo "--- Stages & Transitions ---"

if command -v node &>/dev/null && [ -n "$NODE_PATH_PREFIX" ]; then
  echo "$YAML_CONTENT" | env $NODE_PATH_PREFIX node -e "
    const yaml = require('yaml');
    let data = '';
    process.stdin.on('data', c => data += c);
    process.stdin.on('end', () => {
      const config = yaml.parse(data);
      const stages = config.stages || {};
      const initial = stages.initial_stage;
      delete stages.initial_stage;

      if (Object.keys(stages).length === 0) {
        console.log('  WARN: No stages defined');
        return;
      }

      if (initial) console.log('  Initial stage:', initial);
      console.log();

      for (const [name, s] of Object.entries(stages)) {
        const parts = ['  ' + name + ': type=' + (s.type || '?')];
        if (s.runner) parts.push('runner=' + s.runner);
        if (s.model) parts.push('model=' + s.model);
        if (s.max_turns) parts.push('max_turns=' + s.max_turns);
        if (s.gate_type) parts.push('gate_type=' + s.gate_type);
        if (s.reviewers && s.reviewers.length > 0) {
          const roles = s.reviewers.map(r => r.role || '?');
          parts.push('reviewers=[' + roles.join(', ') + ']');
        }
        const transitions = [];
        for (const key of ['on_complete', 'on_approve', 'on_rework']) {
          if (s[key]) transitions.push(key + '=' + s[key]);
        }
        if (transitions.length > 0) parts.push(transitions.join(' '));
        console.log(parts.join(' '));
      }

      console.log();
      console.log('  Flow:');
      if (initial && stages[initial]) {
        const visited = new Set();
        let current = initial;
        const flow = [];
        while (current && !visited.has(current)) {
          visited.add(current);
          flow.push(current);
          const stage = stages[current] || {};
          current = stage.on_complete || stage.on_approve;
        }
        console.log('    ' + flow.join(' → '));
      }
    });
  "
else
  echo "  WARN: node with yaml package not available — skipping stage summary"
fi

# --- Final result ---
echo ""
if [ "$ERRORS" -gt 0 ]; then
  echo "RESULT: $ERRORS error(s) found"
  exit 1
else
  echo "RESULT: All checks passed"
  exit 0
fi
