#!/usr/bin/env bash
# verify-line-linter.sh — Enforces # Verify: presence and $BASE_URL convention
# Workaround for OpenSpec validate not supporting custom content rules
# ~30 lines as specced

set -euo pipefail

SPECS_DIR="${1:-openspec/specs}"
ERRORS=0

for spec_file in $(find "$SPECS_DIR" -name "*.md" -type f); do
  # Find THEN/AND lines that should have verify lines
  line_num=0
  prev_was_then_or_and=false

  while IFS= read -r line; do
    ((line_num++))

    if echo "$line" | grep -qE '^\s*(Then|And) '; then
      prev_was_then_or_and=true
      then_line=$line_num
      continue
    fi

    if $prev_was_then_or_and; then
      if ! echo "$line" | grep -q '# Verify:'; then
        echo "ERROR: $spec_file:$then_line — THEN/AND clause missing # Verify: line"
        ((ERRORS++))
      elif echo "$line" | grep -q 'localhost'; then
        echo "ERROR: $spec_file:$line_num — Verify line contains hardcoded localhost (use \$BASE_URL)"
        ((ERRORS++))
      fi
      prev_was_then_or_and=false
    fi
  done < "$spec_file"
done

if [ $ERRORS -gt 0 ]; then
  echo ""
  echo "FAIL: $ERRORS verify-line violations found"
  exit 1
fi

echo "PASS: All verify lines present and using \$BASE_URL"
