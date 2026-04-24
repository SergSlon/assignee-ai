#!/usr/bin/env bash
# pre-close-probes.sh — Drive the probe manifest and report pass/fail.
#
# Usage:
#   apps/cli/scripts/pre-close-probes.sh [--scope <regex>]
#   apps/cli/scripts/pre-close-probes.sh --strict-multi-variation
#   apps/cli/scripts/pre-close-probes.sh --tripwire-only
#
# --scope <regex>
#     Only run probes whose `story` matches the regex. Useful for the
#     pre-commit hook to trim execution time.
#
# --strict-multi-variation
#     Epic 98 M2 gate mode. Parses `variations:` counts per probe and
#     exits non-zero if ANY probe has fewer than 3 variations declared.
#     Does NOT execute probe bodies — schema-only.
#
# --tripwire-only
#     Epic 98 M2 gate mode. Runs only the `known_tripwires` entries.
#     EXPECTED-FAIL semantics: every known_tripwire entry carries the
#     exact live-FAIL command from a Wave 2 regression (B-09, C-R1,
#     B-11). The script returns 0 when every tripwire FAILs as
#     declared (its `expected_fail_anchor` grep hits its stderr). Once
#     a Wave 2 fix lands, the tripwire flips to PASS, which the script
#     reports as "FORCING-FLIP: fix landed for <story>" and exits
#     non-zero so the story author knows to remove the tripwire from
#     the manifest in the same commit.
#
# Exit codes:
#   0 — success (all probes pass for --scope / all tripwires fail-as-expected
#       for --tripwire-only / all probes have ≥3 variations for
#       --strict-multi-variation)
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

# Epic 98 M2 — strip the dev-only observability knobs before any probe
# call. `strip_env_leaks` is defined in dogfood-probe-lib.sh; sourcing
# the lib already unsets these once at load, but some probes source
# .env themselves so we re-apply right before dispatch.
strip_env_leaks

# ---------------------------------------------------------------------------
# Minimal YAML parser for our manifest shape.
# ---------------------------------------------------------------------------
# The manifest is a list of entries each with scalar fields (story, name,
# description, must_fail_pre_fix), optional block fields
# (variations:, known_tripwires:), and a block scalar `probe: |`. Output:
#   each probe is dumped to a tempdir as per-entry files:
#     NN.story, NN.name, NN.must_fail_pre_fix, NN.probe.sh,
#     NN.variations_count, NN.known_tripwires.tsv
# NN is a zero-padded index.
#
# `variations_count` is an integer — the number of `- cmd:` entries under
# that probe's `variations:` block.
#
# `known_tripwires.tsv` is TAB-separated lines:
#   <cmd>\t<expected_exit>\t<expected_fail_anchor>
# One line per tripwire entry; file absent if the probe declared no
# known_tripwires (or an empty list).

parse_manifest() {
  local manifest="$1"
  local out_dir="$2"
  awk -v out_dir="$out_dir" '
    BEGIN {
      i = 0
      in_probe = 0
      probe_indent = 0
      in_variations = 0
      in_known_tripwires = 0
      current_tripwire_cmd = ""
      current_tripwire_exit = ""
      current_tripwire_anchor = ""
      current_story = ""
      current_name = ""
      current_mfpf = ""
      variations_count = 0
    }
    # Flush helpers write per-probe files; called on entry boundary.
    function flush_current() {
      if (current_story == "") return
      printf("%s", current_story) > sprintf("%s/%03d.story", out_dir, i)
      printf("%s", current_name)  > sprintf("%s/%03d.name",  out_dir, i)
      printf("%s", current_mfpf)  > sprintf("%s/%03d.must_fail_pre_fix", out_dir, i)
      printf("%d", variations_count) > sprintf("%s/%03d.variations_count", out_dir, i)
      close(sprintf("%s/%03d.story", out_dir, i))
      close(sprintf("%s/%03d.name",  out_dir, i))
      close(sprintf("%s/%03d.must_fail_pre_fix", out_dir, i))
      close(sprintf("%s/%03d.variations_count", out_dir, i))
      close(sprintf("%s/%03d.probe.sh", out_dir, i))
      close(sprintf("%s/%03d.known_tripwires.tsv", out_dir, i))
      i++
    }
    # Flush a pending tripwire tuple when we see the next entry start
    # or the end of the block.
    function flush_tripwire() {
      if (current_tripwire_cmd != "") {
        printf("%s\t%s\t%s\n",
               current_tripwire_cmd,
               current_tripwire_exit,
               current_tripwire_anchor) \
          >> sprintf("%s/%03d.known_tripwires.tsv", out_dir, i)
        current_tripwire_cmd = ""
        current_tripwire_exit = ""
        current_tripwire_anchor = ""
      }
    }
    # Skip blank / comment lines at top level; block-scalar lines are
    # emitted before this filter runs below.
    /^[[:space:]]*#/ && !in_probe { next }

    # Start of a new probe entry (list item at two-space indent with `- story:`).
    /^[[:space:]]{2,4}-[[:space:]]+story:[[:space:]]*/ {
      # Flush any trailing tripwire from previous entry.
      if (in_known_tripwires) flush_tripwire()
      in_known_tripwires = 0
      in_variations = 0
      in_probe = 0
      # Flush previous probe record fully before resetting.
      flush_current()
      # Reset per-entry state.
      current_name = ""
      current_mfpf = "false"
      variations_count = 0
      line = $0
      sub(/^[[:space:]]*-[[:space:]]+story:[[:space:]]*/, "", line)
      current_story = line
      next
    }

    # In the middle of a probe body (block scalar continuation).
    in_probe {
      match($0, /^[[:space:]]*/)
      n = RLENGTH
      if (length($0) == 0) {
        print "" > sprintf("%s/%03d.probe.sh", out_dir, i)
        next
      }
      if (n >= probe_indent) {
        line = substr($0, probe_indent + 1)
        print line > sprintf("%s/%03d.probe.sh", out_dir, i)
        next
      } else {
        in_probe = 0
      }
    }

    # Count variations entries: list items inside `variations:` block.
    # Each variation starts with `      - cmd:` (6 spaces + dash).
    in_variations {
      # New top-level key detection: a key at the same indent as
      # variations: (4 spaces + word + colon) ends the block.
      if ($0 ~ /^[[:space:]]{4}[a-zA-Z_]+:/) {
        in_variations = 0
        # Fall through to matchers below.
      } else {
        # Count items: `      - cmd:` at 6-space + `-` pattern.
        if ($0 ~ /^[[:space:]]{6}-[[:space:]]+cmd:/) {
          variations_count++
        }
        next
      }
    }

    # known_tripwires block parser. Each entry is:
    #   - cmd: "..."
    #     expected_exit: "..."
    #     expected_fail_anchor: "..."
    in_known_tripwires {
      if ($0 ~ /^[[:space:]]{4}[a-zA-Z_]+:/) {
        # New top-level key ends the block.
        flush_tripwire()
        in_known_tripwires = 0
        # fall through
      } else if ($0 ~ /^[[:space:]]{6}-[[:space:]]+cmd:/) {
        # New tripwire entry: flush previous first.
        flush_tripwire()
        line = $0
        sub(/^[[:space:]]+-[[:space:]]+cmd:[[:space:]]*/, "", line)
        gsub(/^["\x27]|["\x27][[:space:]]*$/, "", line)
        current_tripwire_cmd = line
        next
      } else if ($0 ~ /^[[:space:]]{8}expected_exit:/) {
        line = $0
        sub(/^[[:space:]]+expected_exit:[[:space:]]*/, "", line)
        gsub(/^["\x27]|["\x27][[:space:]]*$/, "", line)
        current_tripwire_exit = line
        next
      } else if ($0 ~ /^[[:space:]]{8}expected_fail_anchor:/) {
        line = $0
        sub(/^[[:space:]]+expected_fail_anchor:[[:space:]]*/, "", line)
        gsub(/^["\x27]|["\x27][[:space:]]*$/, "", line)
        current_tripwire_anchor = line
        next
      } else {
        next
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
      next
    }
    /^[[:space:]]+must_fail_pre_fix:[[:space:]]*/ {
      line = $0
      sub(/^[[:space:]]+must_fail_pre_fix:[[:space:]]*/, "", line)
      sub(/[[:space:]]+#.*$/, "", line)
      current_mfpf = line
      next
    }
    /^[[:space:]]{4}variations:[[:space:]]*$/ {
      in_variations = 1
      next
    }
    /^[[:space:]]{4}known_tripwires:[[:space:]]*/ {
      # Initialize empty file (even if list is `[]`).
      printf("") > sprintf("%s/%03d.known_tripwires.tsv", out_dir, i)
      # Detect empty inline form `known_tripwires: []`.
      if ($0 ~ /\[[[:space:]]*\][[:space:]]*$/) {
        next
      }
      in_known_tripwires = 1
      next
    }
    /^[[:space:]]+probe:[[:space:]]*\|[[:space:]]*$/ {
      # Exit the variations/tripwire blocks if we were in them.
      if (in_known_tripwires) { flush_tripwire(); in_known_tripwires = 0 }
      in_variations = 0
      in_probe = 1
      getline nl
      if (match(nl, /^[[:space:]]*/)) {
        probe_indent = RLENGTH
        line = substr(nl, probe_indent + 1)
        print line > sprintf("%s/%03d.probe.sh", out_dir, i)
      }
      next
    }
    END {
      if (in_known_tripwires) flush_tripwire()
      flush_current()
    }
  ' "$manifest"
}

# ---------------------------------------------------------------------------
# Arg parsing.
# ---------------------------------------------------------------------------

SCOPE_REGEX=""
MODE="run"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --scope)
      SCOPE_REGEX="${2:-}"
      shift 2
      ;;
    --strict-multi-variation)
      MODE="strict-multi-variation"
      shift 1
      ;;
    --tripwire-only)
      MODE="tripwire-only"
      shift 1
      ;;
    --help|-h)
      cat <<'EOF'
Usage:
  pre-close-probes.sh [--scope <regex>]
  pre-close-probes.sh --strict-multi-variation
  pre-close-probes.sh --tripwire-only

Modes:
  run (default)             Execute every probe body; report pass/fail.
  --strict-multi-variation  Schema check: every probe must have
                            `variations.length >= 3`. Exits 0 when
                            schema is clean, 1 on violations, 2 on setup
                            errors. Does NOT execute probe bodies.
  --tripwire-only           Run `known_tripwires` entries only. These
                            are forcing-flip witnesses — live-FAIL
                            commands that prove a Wave-2 bug is still
                            present. Exits 0 when every tripwire fails
                            AS DECLARED (expected_fail_anchor visible
                            in stderr, exit matches expected_exit).
                            Exits 1 with `FORCING-FLIP` marker when a
                            tripwire unexpectedly passes — that means
                            the fix landed; remove the tripwire from
                            PROBE_MANIFEST.yaml in the same commit.

Epic 98 M2 acceptance:
  - `--strict-multi-variation` exits 0.
  - `--tripwire-only` reports the 3 known Epic 97 regressions (B-09,
    C-R1, B-11) as EXPECTED-FAIL against current HEAD; exits 0.
  - After Wave 2 lands: `--tripwire-only` reports FORCING-FLIP for
    each entry; story author deletes those tripwires; script exits 0
    again with zero tripwires to check.
EOF
      exit 0
      ;;
    *)
      echo "[pre-close-probes] unknown arg: $1" >&2
      exit 2
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Parse manifest.
# ---------------------------------------------------------------------------

WORK_DIR="$(mktemp -d -t assignee-probes.XXXXXX)"
trap 'rm -rf "$WORK_DIR"' EXIT

parse_manifest "$PROBE_MANIFEST" "$WORK_DIR"

STORY_FILES=()
while IFS= read -r line; do
  STORY_FILES+=("$line")
done < <(find "$WORK_DIR" -name '*.story' | sort)
if [[ ${#STORY_FILES[@]} -eq 0 ]]; then
  echo "[pre-close-probes] no probes parsed from manifest" >&2
  exit 2
fi

# ---------------------------------------------------------------------------
# Mode: --strict-multi-variation
# ---------------------------------------------------------------------------
# Pure schema check. We do NOT execute probe bodies. For every parsed
# probe entry, assert variations_count >= 3. Violations → exit 1 with a
# summary listing each offender.

if [[ "$MODE" == "strict-multi-variation" ]]; then
  OFFENDERS=()
  for sf in "${STORY_FILES[@]}"; do
    prefix="${sf%.story}"
    story="$(cat "$sf")"
    name="$(cat "$prefix.name" 2>/dev/null || echo 'unknown')"
    vcount_file="$prefix.variations_count"
    vcount=0
    if [[ -f "$vcount_file" ]]; then
      vcount="$(cat "$vcount_file")"
    fi
    if [[ -z "$vcount" ]]; then vcount=0; fi
    if [[ "$vcount" -lt 3 ]]; then
      OFFENDERS+=("$story :: $name :: variations=$vcount")
    fi
  done
  echo ""
  echo "=== --strict-multi-variation ==="
  if [[ ${#OFFENDERS[@]} -eq 0 ]]; then
    echo "OK — every probe declares >= 3 variations (Epic 98 M2 gate)."
    exit 0
  fi
  echo "FAIL — ${#OFFENDERS[@]} probe(s) below the 3-variation floor:"
  for off in "${OFFENDERS[@]}"; do
    printf '  %s\n' "$off"
  done
  echo ""
  echo "Each offender must add variations: [{cmd, assertions}, ...]"
  echo "entries in PROBE_MANIFEST.yaml until length >= 3."
  exit 1
fi

# ---------------------------------------------------------------------------
# Mode: --tripwire-only
# ---------------------------------------------------------------------------
# Execute every `known_tripwires` entry. An entry passes ("fails-as-
# expected") when:
#   - the expected_exit semantic matches the observed exit
#   - expected_fail_anchor (if non-empty) appears in combined stdout+stderr
# An entry that unexpectedly succeeds (exit 0 and anchor MISSING) is a
# FORCING-FLIP — the underlying Wave-2 bug is fixed; remove the entry.

if [[ "$MODE" == "tripwire-only" ]]; then
  TOTAL=0
  EXPECTED_FAILS=0
  FORCING_FLIPS=()
  MALFORMED=()
  RESULTS=()

  for sf in "${STORY_FILES[@]}"; do
    prefix="${sf%.story}"
    tripwire_file="$prefix.known_tripwires.tsv"
    story="$(cat "$sf")"
    name="$(cat "$prefix.name" 2>/dev/null || echo 'unknown')"
    if [[ ! -s "$tripwire_file" ]]; then
      continue
    fi
    while IFS=$'\t' read -r tw_cmd tw_exit tw_anchor; do
      TOTAL=$((TOTAL + 1))
      if [[ -z "$tw_cmd" ]]; then
        MALFORMED+=("$story :: $name :: empty cmd")
        continue
      fi
      # strip_env_leaks per D-22.
      strip_env_leaks
      # Execute the tripwire cmd as a full bash expression. The cmd may
      # start with `$PROBE_CLI_BIN` (e.g. `$PROBE_CLI_BIN plan ... --json`)
      # for CLI tripwires, or be a `node -e '...'` form for tripwires that
      # exercise a compiled module directly (e.g. the placeholder guard).
      # Running as arbitrary bash gives authors the expressive power that
      # Epic 97's in-source-code reproducers need.
      #
      # cd to PROBE_REPO_ROOT first so that CLI tripwires find the repo
      # .env / .assignee/config.yaml regardless of the caller's cwd.
      # Under `pnpm --filter assignee`, cwd is `apps/cli/` and the CLI
      # would otherwise surface CONFIGURATION_ERROR (no AWS creds) before
      # reaching the bug under test.
      local_out="$(mktemp)"
      local_err="$(mktemp)"
      set +e
      bash -c "set -euo pipefail; cd \"$PROBE_REPO_ROOT\"; source \"$PROBE_LIB\"; export PROBE_CLI_BIN PROBE_REPO_ROOT; $tw_cmd" \
        >"$local_out" 2>"$local_err"
      rc=$?
      set -e
      combined="$(cat "$local_out" "$local_err")"
      rm -f "$local_out" "$local_err"

      # Did the tripwire FAIL as expected?
      expected_exit_ok=1
      case "$tw_exit" in
        zero)     [[ $rc -eq 0 ]] && expected_exit_ok=0 ;;
        non-zero) [[ $rc -ne 0 ]] && expected_exit_ok=0 ;;
        *)        [[ "$rc" == "$tw_exit" ]] && expected_exit_ok=0 ;;
      esac

      anchor_ok=0
      if [[ -n "$tw_anchor" ]]; then
        if printf '%s' "$combined" | grep -qiF -- "$tw_anchor"; then
          anchor_ok=1
        fi
      else
        anchor_ok=1
      fi

      # EXPECTED-FAIL: the bug is still present → pass.
      # FORCING-FLIP: the bug's gone → the tripwire must be removed so
      # the main gate can enforce the invariant going forward.
      if [[ $expected_exit_ok -eq 0 && $anchor_ok -eq 1 ]]; then
        EXPECTED_FAILS=$((EXPECTED_FAILS + 1))
        RESULTS+=("EXPECTED-FAIL $story $name :: $tw_cmd")
      else
        # If the exit was the opposite of expected, the fix landed.
        FORCING_FLIPS+=("$story :: $name :: $tw_cmd (exit=$rc expected=$tw_exit anchor_ok=$anchor_ok)")
        RESULTS+=("FORCING-FLIP $story $name :: $tw_cmd")
      fi
    done < "$tripwire_file"
  done

  echo ""
  echo "=== --tripwire-only ==="
  printf '  %-14s %-25s %s\n' "STATUS" "STORY" "DETAIL"
  printf '  %-14s %-25s %s\n' "------" "-----" "------"
  if [[ ${#RESULTS[@]} -gt 0 ]]; then
    for r in "${RESULTS[@]}"; do
      status="${r%% *}"
      rest="${r#* }"
      story="${rest%% *}"
      detail="${rest#* }"
      printf '  %-14s %-25s %s\n' "$status" "$story" "$detail"
    done
  fi
  echo ""
  echo "Total: $TOTAL  Expected-Fail: $EXPECTED_FAILS  Forcing-Flip: ${#FORCING_FLIPS[@]}  Malformed: ${#MALFORMED[@]}"

  if [[ ${#MALFORMED[@]} -gt 0 ]]; then
    echo "Malformed tripwires (missing cmd):"
    for m in "${MALFORMED[@]}"; do
      printf '  %s\n' "$m"
    done
    exit 2
  fi
  if [[ ${#FORCING_FLIPS[@]} -gt 0 ]]; then
    echo ""
    echo "FORCING-FLIP detected — the following tripwires passed when they"
    echo "should still fail. This means the Wave-2 fix has landed. Remove"
    echo "the matching known_tripwires entry from PROBE_MANIFEST.yaml in"
    echo "the SAME commit, so the main gate enforces the invariant."
    for f in "${FORCING_FLIPS[@]}"; do
      printf '  %s\n' "$f"
    done
    exit 1
  fi
  exit 0
fi

# ---------------------------------------------------------------------------
# Mode: run (default)
# ---------------------------------------------------------------------------

TOTAL=0
PASSED=0
FAILED=0
TRIPPED=0
SKIPPED=0
SETUP_FAILED=0

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

  # Epic 98 M2: strip env leaks before every probe body.
  strip_env_leaks

  # Wrap probe body: re-source the lib (bash -c runs in a fresh shell).
  # cd to REPO_ROOT so probe CLI invocations find .env / config.yaml
  # regardless of caller cwd (pnpm --filter runs from apps/cli).
  set +e
  bash -c "set -euo pipefail; cd \"$PROBE_REPO_ROOT\"; source \"$PROBE_LIB\"; export PROBE_CLI_BIN PROBE_REPO_ROOT; $(cat "$probe_file")"
  rc=$?
  set -e

  if [[ "$mfpf" == "true" ]]; then
    if [[ $rc -eq 0 ]]; then
      # Probe expected to FAIL but PASSED → bug was fixed; author must remove
      # must_fail_pre_fix in the same commit that lands the fix.
      FAILED=$((FAILED + 1))
      RESULTS+=("FAIL $story $name (unexpectedly passed; flip must_fail_pre_fix to false and remove tripwire)")
    elif [[ $rc -eq 2 ]]; then
      SETUP_FAILED=$((SETUP_FAILED + 1))
      RESULTS+=("SETUP $story $name (probe setup failed)")
    else
      # Probe failed as expected (known-open bug on HEAD). Count separately
      # so the gate stays green while the bug is open. TRIP != unexpected FAIL.
      TRIPPED=$((TRIPPED + 1))
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
# TRIP = known-open must_fail_pre_fix bugs (expected failures; gate stays green)
# FAIL = unexpected failures (gate blocks)
echo "Total: $TOTAL  Passed: $PASSED  Tripped (known-open): $TRIPPED  Failed: $FAILED  Setup-failed: $SETUP_FAILED  Skipped: $SKIPPED"

# Only block on unexpected failures or setup failures.
# TRIPPED probes are documented known-open bugs; they do NOT block the gate.
if [[ $FAILED -gt 0 ]]; then
  exit 1
fi
if [[ $SETUP_FAILED -gt 0 ]]; then
  exit 2
fi
exit 0
