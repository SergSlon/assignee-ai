#!/usr/bin/env bash
# test-release-checklist-gate.sh — Unit test for the RELEASE_CHECKLIST.md CI gate logic.
#
# Exercises Probe Axes A, B, C from Story 108-A-06:
#   Axis A — CI gate exits 0 when all items are checked.
#   Axis B — CI gate exits 1 when exactly one BLOCKING item is unchecked (lists that item).
#   Axis C — CI gate exits 1 when all BLOCKING items are unchecked (lists all items).
#
# Usage (from repo root):
#   bash apps/cli/scripts/test-release-checklist-gate.sh
#
# Exit codes:
#   0 — all axes pass
#   1 — at least one axis failed (details printed to stdout)
#
# NOTE: The checklist table is pretty-printed by the repo's pre-commit Prettier
# hook. Status cells look like "| [x]    |" or "| [ ]    |" (with padding spaces).
# All sed patterns use simple literal replacements on the token itself (not
# pipe-delimited boundaries) so they work regardless of cell padding.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
CHECKLIST="$REPO_ROOT/RELEASE_CHECKLIST.md"

if [ ! -f "$CHECKLIST" ]; then
  echo "ERROR: RELEASE_CHECKLIST.md not found at $CHECKLIST"
  exit 1
fi

# ── Helper: run gate logic, return exit code via caller's variable ────────────
#
# DESIGN: We use `return` (not `exit`) so the function works correctly
# in both subshell and command-substitution contexts under `set -e`.

run_gate_capture() {
  local tmpfile="$1"
  local unchecked
  unchecked=$(grep -E "^\| RR-" "$tmpfile" | grep -F "[ ]" || true)
  if [ -n "$unchecked" ]; then
    printf "BLOCKING items still unchecked — cannot proceed to publish:\n\n%s\n" "$unchecked"
    return 1
  fi
  echo "All BLOCKING release-checklist items are checked. Safe to proceed."
  return 0
}

PASS=0
FAIL=0

# ── Axis A: all items checked → gate exits 0 ─────────────────────────────────

echo "=== Axis A: all items checked → expect exit 0 ==="

tmpA=$(mktemp)
# Replace every [ ] token with [x] — works even when prettier has added
# padding spaces inside the table cell (e.g. "| [ ]    |").
sed 's/\[ \]/[x]/g' "$CHECKLIST" >"$tmpA"

axis_a_exit=0
axis_a_output=$(run_gate_capture "$tmpA") || axis_a_exit=$?
rm -f "$tmpA"

if [ "$axis_a_exit" -eq 0 ]; then
  echo "PASS: Axis A — gate exits 0 when all items are checked"
  PASS=$((PASS + 1))
else
  echo "FAIL: Axis A — gate should exit 0 when all items are checked"
  echo "  Output: $axis_a_output"
  FAIL=$((FAIL + 1))
fi

# ── Axis B: exactly RR-1 unchecked → gate exits 1, names RR-1 ────────────────

echo ""
echo "=== Axis B: RR-1 unchecked → expect exit 1 with RR-1 in output ==="

tmpB=$(mktemp)
# Start with all items checked, then restore the RR-1 row to unchecked.
# Step 1: check everything.
# Step 2: on the RR-1 line, replace the first [x] back to [ ].
sed 's/\[ \]/[x]/g' "$CHECKLIST" \
  | sed '/^\| RR-1[[:space:]]/s/\[x\]/[ ]/' \
  >"$tmpB"

axis_b_exit=0
axis_b_output=$(run_gate_capture "$tmpB") || axis_b_exit=$?
rm -f "$tmpB"

if [ "$axis_b_exit" -ne 0 ] && echo "$axis_b_output" | grep -qF "| RR-1"; then
  echo "PASS: Axis B — gate exits non-zero and names RR-1"
  PASS=$((PASS + 1))
else
  echo "FAIL: Axis B — expected exit non-zero with RR-1 in output"
  echo "  Exit code: $axis_b_exit"
  echo "  Output: $axis_b_output"
  FAIL=$((FAIL + 1))
fi

# ── Axis C: all items unchecked → gate exits 1, lists all RR- rows ───────────

echo ""
echo "=== Axis C: all items unchecked → expect exit 1 listing all rows ==="

tmpC=$(mktemp)
# Replace every [x] token with [ ] so every item is unchecked.
sed 's/\[x\]/[ ]/g' "$CHECKLIST" >"$tmpC"

# Count expected unchecked rows in the fixture (should be 12 — all of them).
unchecked_count=$(grep -E "^\| RR-" "$tmpC" | grep -cF "[ ]" || true)

axis_c_exit=0
axis_c_output=$(run_gate_capture "$tmpC") || axis_c_exit=$?
rm -f "$tmpC"

# Count rows appearing in the output
output_row_count=$(echo "$axis_c_output" | grep -cE "^\| RR-" || true)

if [ "$axis_c_exit" -ne 0 ] && [ "$output_row_count" -ge "$unchecked_count" ]; then
  echo "PASS: Axis C — gate exits non-zero and lists all $unchecked_count unchecked rows"
  PASS=$((PASS + 1))
else
  echo "FAIL: Axis C — expected exit non-zero with $unchecked_count rows in output, got $output_row_count"
  echo "  Exit code: $axis_c_exit"
  FAIL=$((FAIL + 1))
fi

# ── Summary ───────────────────────────────────────────────────────────────────

echo ""
echo "=== Results: $PASS passed, $FAIL failed ==="

if [ "$FAIL" -gt 0 ]; then
  exit 1
fi

exit 0
