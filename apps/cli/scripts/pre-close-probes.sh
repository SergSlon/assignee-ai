#!/usr/bin/env bash
# pre-close-probes.sh — Drive the probe manifest and report pass/fail.
#
# Usage:
#   apps/cli/scripts/pre-close-probes.sh [--scope <regex>]
#
# --scope <regex>  Only run probes whose `story` matches the regex.
#                  Useful for the pre-commit hook to trim execution time.
#
# Exit codes:
#   0 — all probes pass (taking `must_fail_pre_fix` into account)
#   1 — one or more probes failed unexpectedly (gate tripwire)
#   2 — runner setup error (jq/bash missing, manifest malformed)
#
# No yq dependency — uses a minimal awk-based parser for the YAML shape
# owned by this repo. If you extend PROBE_MANIFEST.yaml with richer
# YAML (anchors, flow sequences), update the parser here.

set -euo pipefail

# ---------------------------------------------------------------------------
# Locate repo root and source the probe library.
# ---------------------------------------------------------------------------

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"

PROBE_LIB="$SCRIPT_DIR/dogfood-probe-lib.sh"
PROBE_MANIFEST="$SCRIPT_DIR/PROBE_MANIFEST.yaml"

if [[ ! -f "$PROBE_LIB" ]]; then
  echo "[pre-close-probes] missing probe lib: $PROBE_LIB" >&2
  exit 2
fi
if [[ ! -f "$PROBE_MANIFEST" ]]; then
  echo "[pre-close-probes] missing manifest: $PROBE_MANIFEST" >&2
  exit 2
fi

# shellcheck disable=SC1090
source "$PROBE_LIB"

# ---------------------------------------------------------------------------
# Environment & CLI binary discovery.
# ---------------------------------------------------------------------------

export PROBE_REPO_ROOT="$REPO_ROOT"
# The CLI dist is required for probes that exercise the binary. Build
# first if missing; parallel commit hooks rebuild via turbo.
CLI_DIST="$REPO_ROOT/apps/cli/dist/index.js"
if [[ ! -f "$CLI_DIST" ]]; then
  echo "[pre-close-probes] apps/cli/dist/index.js not built — run 'pnpm --filter assignee build'" >&2
  exit 2
fi
export PROBE_CLI_BIN="node $CLI_DIST"

# Optional: source .env for AWS vars when probes opt into live calls.
# Probes MUST NOT depend on real AWS; seeded probes use placeholder IDs
# that fail fast before reaching AWS.
if [[ -f "$REPO_ROOT/.env" && "${PROBE_SOURCE_ENV:-0}" == "1" ]]; then
  # shellcheck disable=SC1091
  set +u; source "$REPO_ROOT/.env"; set -u
fi

# ---------------------------------------------------------------------------
# Minimal YAML parser for our manifest shape.
# ---------------------------------------------------------------------------
# The manifest is a list of entries each with scalar fields (story, name,
# description, must_fail_pre_fix) and a block scalar `probe: |`. Output:
#   each probe is dumped to a tempdir as 4 files:
#     NN.story, NN.name, NN.must_fail_pre_fix, NN.probe.sh
# NN is a zero-padded index.

parse_manifest() {
  local manifest="$1"
  local out_dir="$2"
  awk -v out_dir="$out_dir" '
    BEGIN {
      i = 0
      in_probe = 0
      probe_indent = 0
      current_story = ""
      current_name = ""
      current_mfpf = ""
    }
    # Skip blank lines inside the header; within a probe block they stay.
    /^[[:space:]]*#/ && !in_probe { next }

    # Start of a new probe entry (list item at two-space indent).
    /^[[:space:]]{2,4}-[[:space:]]+story:[[:space:]]*/ {
      # Flush previous probe if any.
      if (current_story != "") {
        # Write meta.
        printf("%s", current_story) > sprintf("%s/%03d.story", out_dir, i)
        printf("%s", current_name)  > sprintf("%s/%03d.name",  out_dir, i)
        printf("%s", current_mfpf)  > sprintf("%s/%03d.must_fail_pre_fix", out_dir, i)
        close(sprintf("%s/%03d.story", out_dir, i))
        close(sprintf("%s/%03d.name",  out_dir, i))
        close(sprintf("%s/%03d.must_fail_pre_fix", out_dir, i))
        # Probe body already flushed incrementally; close it.
        close(sprintf("%s/%03d.probe.sh", out_dir, i))
        i++
      }
      in_probe = 0
      line = $0
      sub(/^[[:space:]]*-[[:space:]]+story:[[:space:]]*/, "", line)
      current_story = line
      current_name = ""
      current_mfpf = "false"
      next
    }

    # In the middle of a probe body (block scalar continuation).
    in_probe {
      # Determine line indent.
      match($0, /^[[:space:]]*/)
      n = RLENGTH
      # Empty line inside a probe is preserved.
      if (length($0) == 0) {
        print "" > sprintf("%s/%03d.probe.sh", out_dir, i)
        next
      }
      if (n >= probe_indent) {
        # Strip exactly probe_indent spaces.
        line = substr($0, probe_indent + 1)
        print line > sprintf("%s/%03d.probe.sh", out_dir, i)
        next
      } else {
        # Dedent — end of block.
        in_probe = 0
        # Fall through to scalar matchers below.
      }
    }

    # Scalar keys inside a probe entry.
    /^[[:space:]]+name:[[:space:]]*/ {
      line = $0
      sub(/^[[:space:]]+name:[[:space:]]*/, "", line)
      current_name = line
      next
    }
    /^[[:space:]]+description:[[:space:]]*/ {
      # Description is block-scalar "|" or single-line; we drop it.
      next
    }
    /^[[:space:]]+must_fail_pre_fix:[[:space:]]*/ {
      line = $0
      sub(/^[[:space:]]+must_fail_pre_fix:[[:space:]]*/, "", line)
      # strip trailing whitespace / comments
      sub(/[[:space:]]+#.*$/, "", line)
      current_mfpf = line
      next
    }
    /^[[:space:]]+probe:[[:space:]]*\|[[:space:]]*$/ {
      in_probe = 1
      # probe block body is indented by the indent of the NEXT line.
      # Peek: read next line to set probe_indent.
      getline nl
      if (match(nl, /^[[:space:]]*/)) {
        probe_indent = RLENGTH
        # Write the first line.
        line = substr(nl, probe_indent + 1)
        print line > sprintf("%s/%03d.probe.sh", out_dir, i)
      }
      next
    }
    END {
      # Flush last probe if any.
      if (current_story != "") {
        printf("%s", current_story) > sprintf("%s/%03d.story", out_dir, i)
        printf("%s", current_name)  > sprintf("%s/%03d.name",  out_dir, i)
        printf("%s", current_mfpf)  > sprintf("%s/%03d.must_fail_pre_fix", out_dir, i)
        close(sprintf("%s/%03d.probe.sh", out_dir, i))
      }
    }
  ' "$manifest"
}

# ---------------------------------------------------------------------------
# Arg parsing.
# ---------------------------------------------------------------------------

SCOPE_REGEX=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --scope)
      SCOPE_REGEX="${2:-}"
      shift 2
      ;;
    --help|-h)
      echo "Usage: $0 [--scope <regex>]"
      exit 0
      ;;
    *)
      echo "[pre-close-probes] unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Main.
# ---------------------------------------------------------------------------

WORK_DIR="$(mktemp -d -t assignee-probes.XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT

parse_manifest "$PROBE_MANIFEST" "$WORK_DIR"

# Collect probe files (bash-3.2 compatible, macOS default).
STORY_FILES=()
while IFS= read -r line; do
  STORY_FILES+=("$line")
done < <(find "$WORK_DIR" -name '*.story' | sort)
if [[ ${#STORY_FILES[@]} -eq 0 ]]; then
  echo "[pre-close-probes] no probes parsed from manifest" >&2
  exit 2
fi

TOTAL=0
PASSED=0
FAILED=0
TRIPPED=0
SKIPPED=0
SETUP_FAILED=0

# Per-probe results for the summary table.
RESULTS=()

for sf in "${STORY_FILES[@]}"; do
  prefix="${sf%.story}"
  story="$(cat "$sf")"
  name="$(cat "$prefix.name" 2>/dev/null || echo "unknown")"
  mfpf="$(cat "$prefix.must_fail_pre_fix" 2>/dev/null || echo "false")"
  probe_file="$prefix.probe.sh"
  if [[ ! -f "$probe_file" ]]; then
    echo "[pre-close-probes] probe body missing for $story" >&2
    continue
  fi

  if [[ -n "$SCOPE_REGEX" ]] && ! [[ "$story" =~ $SCOPE_REGEX ]]; then
    SKIPPED=$((SKIPPED + 1))
    RESULTS+=("SKIP $story $name")
    continue
  fi

  TOTAL=$((TOTAL + 1))

  # Wrap probe body: re-source the lib (bash -c runs in a fresh shell).
  set +e
  bash -c "set -euo pipefail; source \"$PROBE_LIB\"; export PROBE_CLI_BIN PROBE_REPO_ROOT; $(cat "$probe_file")"
  rc=$?
  set -e

  # Interpret rc against must_fail_pre_fix.
  #
  # Policy: a probe labelled `must_fail_pre_fix: true` represents a
  # KNOWN BUG on the current tree. The probe failing IS the bug; the
  # bug is still unfixed. The overall gate MUST report non-zero in that
  # case so downstream consumers (CI, pre-commit hook) block. The
  # "TRIP" label distinguishes expected failures from regressions.
  if [[ "$mfpf" == "true" ]]; then
    if [[ $rc -eq 0 ]]; then
      # Probe expected to fail on current tree but passed — the bug was
      # just fixed (flip must_fail_pre_fix to false) OR the probe logic
      # is too lax. Either way, this is a FAIL so the author notices.
      FAILED=$((FAILED + 1))
      RESULTS+=("FAIL $story $name (unexpectedly passed; flip must_fail_pre_fix to false)")
    elif [[ $rc -eq 2 ]]; then
      SETUP_FAILED=$((SETUP_FAILED + 1))
      RESULTS+=("SETUP $story $name (probe setup failed)")
    else
      # Expected failure on HEAD — labelled TRIP but still increments
      # FAILED so the overall gate exits non-zero.
      TRIPPED=$((TRIPPED + 1))
      FAILED=$((FAILED + 1))
      RESULTS+=("TRIP $story $name (known bug on HEAD — fix then flip must_fail_pre_fix)")
    fi
  else
    if [[ $rc -eq 0 ]]; then
      PASSED=$((PASSED + 1))
      RESULTS+=("PASS $story $name")
    elif [[ $rc -eq 2 ]]; then
      SETUP_FAILED=$((SETUP_FAILED + 1))
      RESULTS+=("SETUP $story $name (probe setup failed)")
    else
      FAILED=$((FAILED + 1))
      RESULTS+=("FAIL $story $name")
    fi
  fi
done

# ---------------------------------------------------------------------------
# Summary table.
# ---------------------------------------------------------------------------

echo ""
echo "=== Pre-close probe results ==="
printf '  %-8s %-25s %s\n' "STATUS" "STORY" "NAME"
printf '  %-8s %-25s %s\n' "------" "-----" "----"
for r in "${RESULTS[@]}"; do
  status="${r%% *}"
  rest="${r#* }"
  story="${rest%% *}"
  name="${rest#* }"
  printf '  %-8s %-25s %s\n' "$status" "$story" "$name"
done
echo ""
echo "Total: $TOTAL  Passed: $PASSED  Failed: $FAILED (of which Tripped: $TRIPPED)  Setup-failed: $SETUP_FAILED  Skipped: $SKIPPED"

# The overall gate:
#   - Any FAIL -> exit 1 (real regression OR an expected-fail probe passed,
#     both of which need attention).
#   - Any SETUP failure -> exit 2 (runner broken).
if [[ $FAILED -gt 0 ]]; then
  exit 1
fi
if [[ $SETUP_FAILED -gt 0 ]]; then
  exit 2
fi
exit 0
