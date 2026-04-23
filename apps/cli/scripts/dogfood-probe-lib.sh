#!/usr/bin/env bash
# dogfood-probe-lib.sh — Reusable probe helpers for the pre-close gate.
#
# Each helper:
#   - Sources set -euo pipefail.
#   - Returns 0 on PASS, 1 on FAIL_ASSERTION, 2 on FAIL_SETUP (jq missing,
#     CMD exited unexpectedly, no CLI binary, etc.).
#   - Prints a one-line reason on FAIL to stderr.
#
# Usage:
#   source "$(dirname "$0")/dogfood-probe-lib.sh"
#   PROBE_CLI_BIN="${PROBE_CLI_BIN:-node apps/cli/dist/index.js}"
#   assert_single_examples_block $PROBE_CLI_BIN plan --help
#
# See PROBE_MANIFEST.yaml for the catalogue of probes keyed by story-ID
# and pre-close-probes.sh for the driver.
#
# Exit codes are by contract: do not reinterpret them in callers.

set -euo pipefail

# ---------------------------------------------------------------------------
# Internal helpers (not exported as probes).
# ---------------------------------------------------------------------------

_probe_fail() {
  # $1 = probe name, $2 = one-line reason
  printf '[PROBE-FAIL] %s: %s\n' "$1" "$2" >&2
  return 1
}

_probe_setup_fail() {
  # $1 = probe name, $2 = one-line reason
  printf '[PROBE-SETUP-FAIL] %s: %s\n' "$1" "$2" >&2
  return 2
}

_probe_require_jq() {
  if ! command -v jq >/dev/null 2>&1; then
    _probe_setup_fail "${1:-unknown}" "jq not on PATH"
    return 2
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Probe 1 — envelope shape
# ---------------------------------------------------------------------------
# Args: PROBE_NAME OUTPUT_JSON EXPECTED_JQ_EXPR
# Runs `jq -e EXPR` against OUTPUT_JSON. Exit 0 if expression is truthy;
# 1 if the expression is false/null; 2 if jq failed to parse.
assert_envelope_shape() {
  local name="${1:-envelope}"
  local json="${2:-}"
  local expr="${3:-}"
  _probe_require_jq "$name" || return 2
  if [[ -z "$json" ]]; then
    _probe_setup_fail "$name" "empty JSON input"
    return 2
  fi
  if ! printf '%s' "$json" | jq -e "$expr" >/dev/null 2>&1; then
    if ! printf '%s' "$json" | jq . >/dev/null 2>&1; then
      _probe_setup_fail "$name" "input was not valid JSON"
      return 2
    fi
    _probe_fail "$name" "jq expression did not match: $expr"
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Probe 2 — exit code matches ok flag (catches A-02)
# ---------------------------------------------------------------------------
# Args: EXPECT_EXIT EXPECT_OK CMD...
# Runs CMD, captures stdout+stderr+exit, parses the last `{...}` block
# from stdout as JSON, asserts:
#   exit matches EXPECT_EXIT AND (.ok // false) == EXPECT_OK
#
# EXPECT_EXIT accepts:
#   - a specific integer ("0", "10", ...)
#   - "zero" (matches exit == 0)
#   - "non-zero" (matches exit != 0)
# EXPECT_OK must be literal "true" or "false".
#
# The "non-zero" form is the canonical A-02 tripwire: whenever the
# envelope is ok:false, the exit code MUST be non-zero. Passing
# EXPECT_OK=false EXPECT_EXIT=non-zero catches the "silently succeeded"
# class without coupling to a specific error code.
assert_exit_code_matches_ok() {
  local name="exit_code_matches_ok"
  local expect_exit="${1:-0}"
  local expect_ok="${2:-true}"
  shift 2 || true
  if [[ $# -eq 0 ]]; then
    _probe_setup_fail "$name" "no CMD provided"
    return 2
  fi
  _probe_require_jq "$name" || return 2
  local stdout stderr exit_code
  local tmp_out tmp_err
  tmp_out="$(mktemp)"
  tmp_err="$(mktemp)"
  set +e
  "$@" >"$tmp_out" 2>"$tmp_err"
  exit_code=$?
  set -e
  stdout="$(cat "$tmp_out")"
  stderr="$(cat "$tmp_err")"
  rm -f "$tmp_out" "$tmp_err"
  # Extract last JSON object envelope — prefer the trailing {...} block.
  local envelope
  envelope="$(printf '%s' "$stdout" | awk '/^\{/{block=$0; capture=1; next} capture{block=block"\n"$0} END{print block}')"
  if [[ -z "$envelope" ]] || ! printf '%s' "$envelope" | jq . >/dev/null 2>&1; then
    _probe_fail "$name" "no JSON envelope on stdout (exit=$exit_code, stderr first line: $(printf '%s' "$stderr" | head -1))"
    return 1
  fi
  local ok_val
  ok_val="$(printf '%s' "$envelope" | jq -r '.ok // false')"
  # Exit-code match with flexible forms.
  local exit_ok=0
  case "$expect_exit" in
    zero)
      [[ "$exit_code" -eq 0 ]] || exit_ok=1
      ;;
    non-zero)
      [[ "$exit_code" -ne 0 ]] || exit_ok=1
      ;;
    *)
      [[ "$exit_code" == "$expect_exit" ]] || exit_ok=1
      ;;
  esac
  if [[ $exit_ok -ne 0 ]]; then
    _probe_fail "$name" "expected exit $expect_exit, got $exit_code (ok=$ok_val)"
    return 1
  fi
  if [[ "$ok_val" != "$expect_ok" ]]; then
    _probe_fail "$name" "expected .ok=$expect_ok, got .ok=$ok_val (exit=$exit_code)"
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Probe 3 — ARN visible in success envelope
# ---------------------------------------------------------------------------
# Args: CMD...
# Runs CMD, parses the stdout envelope, asserts ok==true AND
# (.arn // .resourceArn // .plan.resourceArn // .plans[0].resourceArn)
# matches /^arn:aws[\w-]*:/ (partition-aware, per repo convention).
assert_arn_visible_in_success() {
  local name="arn_visible_in_success"
  if [[ $# -eq 0 ]]; then
    _probe_setup_fail "$name" "no CMD provided"
    return 2
  fi
  _probe_require_jq "$name" || return 2
  local stdout
  stdout="$("$@" 2>/dev/null || true)"
  local envelope
  envelope="$(printf '%s' "$stdout" | awk '/^\{/{block=$0; capture=1; next} capture{block=block"\n"$0} END{print block}')"
  if [[ -z "$envelope" ]] || ! printf '%s' "$envelope" | jq . >/dev/null 2>&1; then
    _probe_fail "$name" "no JSON envelope on stdout"
    return 1
  fi
  # Must be ok=true.
  if ! printf '%s' "$envelope" | jq -e '.ok == true' >/dev/null 2>&1; then
    _probe_fail "$name" "envelope is not ok:true"
    return 1
  fi
  local arn
  arn="$(printf '%s' "$envelope" | jq -r '.arn // .resourceArn // .plan.resourceArn // (.plans // [])[0].resourceArn // empty')"
  if [[ -z "$arn" ]]; then
    _probe_fail "$name" "no ARN field found in envelope"
    return 1
  fi
  if ! [[ "$arn" =~ ^arn:aws[a-zA-Z0-9-]*: ]]; then
    _probe_fail "$name" "ARN '$arn' does not match /^arn:aws[\\w-]*:/"
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Probe 4 — single Examples block in --help (catches A-04/D-01/D-08)
# ---------------------------------------------------------------------------
# Args: CMD...
# Runs `CMD`, counts case-sensitive `Examples:` occurrences across the
# combined stdout+stderr of the command, asserts exactly 1.
assert_single_examples_block() {
  local name="single_examples_block"
  if [[ $# -eq 0 ]]; then
    _probe_setup_fail "$name" "no CMD provided"
    return 2
  fi
  local combined count
  combined="$("$@" 2>&1 || true)"
  count="$(printf '%s\n' "$combined" | grep -c '^Examples:$' || true)"
  if [[ -z "$count" ]]; then count=0; fi
  if [[ "$count" -ne 1 ]]; then
    _probe_fail "$name" "expected exactly 1 'Examples:' heading, found $count"
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Probe 5 — placeholder input is rejected (catches placeholder-ARN class)
# ---------------------------------------------------------------------------
# Args: CMD...
# Runs CMD (which receives a placeholder input elsewhere in the args),
# asserts the envelope has ok:false AND the error.code or error.message
# contains the substring "placeholder" (case-insensitive).
assert_no_placeholder() {
  local name="no_placeholder"
  if [[ $# -eq 0 ]]; then
    _probe_setup_fail "$name" "no CMD provided"
    return 2
  fi
  _probe_require_jq "$name" || return 2
  local stdout
  stdout="$("$@" 2>/dev/null || true)"
  local envelope
  envelope="$(printf '%s' "$stdout" | awk '/^\{/{block=$0; capture=1; next} capture{block=block"\n"$0} END{print block}')"
  if [[ -z "$envelope" ]] || ! printf '%s' "$envelope" | jq . >/dev/null 2>&1; then
    _probe_fail "$name" "no JSON envelope on stdout (placeholder input should fail loudly)"
    return 1
  fi
  if ! printf '%s' "$envelope" | jq -e '.ok == false' >/dev/null 2>&1; then
    _probe_fail "$name" "envelope was ok:true on placeholder input — silent accept"
    return 1
  fi
  local combined
  combined="$(printf '%s' "$envelope" | jq -r '(.error.code // "") + " " + (.error.message // "")')"
  if ! printf '%s' "$combined" | grep -qi 'placeholder\|example\|123456789012'; then
    _probe_fail "$name" "error did not mention placeholder/example/123456789012: $combined"
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Probe 6 — stderr substring appears at most once (catches D-02 duplicate hint)
# ---------------------------------------------------------------------------
# Args: SUBSTR CMD...
# Runs CMD, counts occurrences of SUBSTR on stderr only, asserts ≤ 1.
assert_single_stderr_substring() {
  local name="single_stderr_substring"
  local substr="${1:-}"
  shift || true
  if [[ -z "$substr" ]]; then
    _probe_setup_fail "$name" "no SUBSTR provided"
    return 2
  fi
  if [[ $# -eq 0 ]]; then
    _probe_setup_fail "$name" "no CMD provided"
    return 2
  fi
  local stderr count
  stderr="$("$@" 2>&1 >/dev/null || true)"
  count="$(printf '%s\n' "$stderr" | grep -cF -- "$substr" || true)"
  if [[ -z "$count" ]]; then count=0; fi
  if [[ "$count" -gt 1 ]]; then
    _probe_fail "$name" "substring '$substr' appeared $count times on stderr (expected ≤ 1)"
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Probe 7 — plan has resource type
# ---------------------------------------------------------------------------
# Args: TYPE CMD...
# Runs CMD (must emit JSON envelope), asserts at least one plan has
# .resourceType == TYPE OR root .plan.resourceType == TYPE.
assert_plan_has_resource_type() {
  local name="plan_has_resource_type"
  local expected_type="${1:-}"
  shift || true
  if [[ -z "$expected_type" ]]; then
    _probe_setup_fail "$name" "no TYPE provided"
    return 2
  fi
  if [[ $# -eq 0 ]]; then
    _probe_setup_fail "$name" "no CMD provided"
    return 2
  fi
  _probe_require_jq "$name" || return 2
  local stdout envelope
  stdout="$("$@" 2>/dev/null || true)"
  envelope="$(printf '%s' "$stdout" | awk '/^\{/{block=$0; capture=1; next} capture{block=block"\n"$0} END{print block}')"
  if [[ -z "$envelope" ]] || ! printf '%s' "$envelope" | jq . >/dev/null 2>&1; then
    _probe_fail "$name" "no JSON envelope on stdout"
    return 1
  fi
  if ! printf '%s' "$envelope" | jq -e --arg T "$expected_type" \
    '[.plan?.resourceType, (.plans // [])[]?.resourceType] | map(select(. != null)) | any(. == $T)' \
    >/dev/null 2>&1; then
    _probe_fail "$name" "no plan has resourceType == $expected_type"
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Probe 8 — desiredState has key
# ---------------------------------------------------------------------------
# Args: KEY CMD...
# Runs CMD, asserts any desiredState (root .desiredState or
# .plan.desiredState or any .plans[].desiredState) contains KEY.
assert_desired_state_has_key() {
  local name="desired_state_has_key"
  local key="${1:-}"
  shift || true
  if [[ -z "$key" ]]; then
    _probe_setup_fail "$name" "no KEY provided"
    return 2
  fi
  if [[ $# -eq 0 ]]; then
    _probe_setup_fail "$name" "no CMD provided"
    return 2
  fi
  _probe_require_jq "$name" || return 2
  local stdout envelope
  stdout="$("$@" 2>/dev/null || true)"
  envelope="$(printf '%s' "$stdout" | awk '/^\{/{block=$0; capture=1; next} capture{block=block"\n"$0} END{print block}')"
  if [[ -z "$envelope" ]] || ! printf '%s' "$envelope" | jq . >/dev/null 2>&1; then
    _probe_fail "$name" "no JSON envelope on stdout"
    return 1
  fi
  if ! printf '%s' "$envelope" | jq -e --arg K "$key" \
    '[(.desiredState // {}), (.plan?.desiredState // {}), ((.plans // [])[]?.desiredState // {})] | map(select(. != null)) | any(has($K))' \
    >/dev/null 2>&1; then
    _probe_fail "$name" "no desiredState contains key '$key'"
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Probe 9 — desiredState on type SLOT_TYPE does NOT contain FORBIDDEN_KEY
# ---------------------------------------------------------------------------
# Args: SLOT_TYPE FORBIDDEN_KEY CMD...
# Catches A-01: Lambda compound FunctionName leaking into IAM Role slot.
assert_desired_state_missing_key_on_type() {
  local name="desired_state_missing_key_on_type"
  local slot_type="${1:-}"
  local forbidden_key="${2:-}"
  shift 2 || true
  if [[ -z "$slot_type" || -z "$forbidden_key" ]]; then
    _probe_setup_fail "$name" "SLOT_TYPE or FORBIDDEN_KEY missing"
    return 2
  fi
  if [[ $# -eq 0 ]]; then
    _probe_setup_fail "$name" "no CMD provided"
    return 2
  fi
  _probe_require_jq "$name" || return 2
  local stdout envelope
  stdout="$("$@" 2>/dev/null || true)"
  envelope="$(printf '%s' "$stdout" | awk '/^\{/{block=$0; capture=1; next} capture{block=block"\n"$0} END{print block}')"
  if [[ -z "$envelope" ]] || ! printf '%s' "$envelope" | jq . >/dev/null 2>&1; then
    _probe_fail "$name" "no JSON envelope on stdout"
    return 1
  fi
  # Find plans matching SLOT_TYPE and assert none contain FORBIDDEN_KEY.
  local leak
  leak="$(printf '%s' "$envelope" | jq -r --arg T "$slot_type" --arg K "$forbidden_key" \
    '[(.plans // [])[] | select(.resourceType == $T) | select(.desiredState and (.desiredState | has($K)))] | length')"
  if [[ "$leak" -gt 0 ]]; then
    _probe_fail "$name" "FORBIDDEN_KEY '$forbidden_key' leaked into $leak plan(s) of type $slot_type"
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Probe 10 — regex scope (rejects BAD, matches GOOD)
# ---------------------------------------------------------------------------
# Args: BAD GOOD REGEX
# Tests REGEX against BAD (must NOT match) and GOOD (must match) using
# `grep -E` (POSIX ERE) for portability — macOS bash 3.2's built-in [[ =~ ]]
# does not support \b word anchors. Catches B3 region false positives
# without having to spin up the assignee graph.
#
# The REGEX is expected to be POSIX-ERE-compatible. Word-boundary anchors
# should be written as `(^|[^a-zA-Z0-9])` and `([^a-zA-Z0-9]|$)` rather
# than `\b` — `grep -E` does not support `\b` on BSD grep. If you need
# Perl-style anchors, call `grep -P` via a separate helper.
assert_regex_scope() {
  local name="regex_scope"
  local bad="${1:-}"
  local good="${2:-}"
  local pattern="${3:-}"
  if [[ -z "$pattern" ]]; then
    _probe_setup_fail "$name" "REGEX missing"
    return 2
  fi
  # Use grep -E; match if exit 0.
  if printf '%s' "$bad" | grep -E -q -- "$pattern"; then
    _probe_fail "$name" "pattern '$pattern' matched BAD input '$bad' (expected NO match)"
    return 1
  fi
  if ! printf '%s' "$good" | grep -E -q -- "$pattern"; then
    _probe_fail "$name" "pattern '$pattern' did NOT match GOOD input '$good' (expected match)"
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Probe 11 — envelope has ok:false AND error.code / error.message
# ---------------------------------------------------------------------------
# Convenience helper: runs CMD, asserts error envelope shape is well-formed
# (ok:false, error.code non-empty, error.message non-empty).
assert_error_envelope_shape() {
  local name="error_envelope_shape"
  if [[ $# -eq 0 ]]; then
    _probe_setup_fail "$name" "no CMD provided"
    return 2
  fi
  _probe_require_jq "$name" || return 2
  local stdout envelope
  stdout="$("$@" 2>/dev/null || true)"
  envelope="$(printf '%s' "$stdout" | awk '/^\{/{block=$0; capture=1; next} capture{block=block"\n"$0} END{print block}')"
  if [[ -z "$envelope" ]] || ! printf '%s' "$envelope" | jq . >/dev/null 2>&1; then
    _probe_fail "$name" "no JSON envelope on stdout"
    return 1
  fi
  if ! printf '%s' "$envelope" | jq -e '.ok == false and (.error.code | type == "string" and length > 0) and (.error.message | type == "string" and length > 0)' >/dev/null 2>&1; then
    _probe_fail "$name" "envelope missing ok:false OR error.code OR error.message"
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Probe 12 — BP finding MUST NOT surface
# ---------------------------------------------------------------------------
# Args: BP_ID CMD...
# Runs CMD, parses the JSON envelope, asserts no element of
# `.plan.bpFindings[]` (or `.plans[].bpFindings[]` for compounds) has
# practiceId == BP_ID. Fails if jq is missing, envelope malformed, or
# the forbidden finding is present.
#
# Use this when a predicate-narrowing fix claims "BP-X must not fire on
# intent Y". Catches the awareness-style over-firing class (BP-SG-007
# on port 443, BP-SG-005 pre-Epic-94-R4, etc.).
assert_no_bp_finding_id() {
  local name="no_bp_finding_id"
  local bp_id="${1:-}"
  shift || true
  if [[ -z "$bp_id" ]]; then
    _probe_setup_fail "$name" "no BP_ID provided"
    return 2
  fi
  if [[ $# -eq 0 ]]; then
    _probe_setup_fail "$name" "no CMD provided"
    return 2
  fi
  _probe_require_jq "$name" || return 2
  local stdout envelope
  stdout="$("$@" 2>/dev/null || true)"
  envelope="$(printf '%s' "$stdout" | awk '/^\{/{block=$0; capture=1; next} capture{block=block"\n"$0} END{print block}')"
  if [[ -z "$envelope" ]] || ! printf '%s' "$envelope" | jq . >/dev/null 2>&1; then
    _probe_fail "$name" "no JSON envelope on stdout"
    return 1
  fi
  local hits
  hits="$(printf '%s' "$envelope" | jq -r --arg ID "$bp_id" \
    '[(.plan?.bpFindings // []), ((.plans // [])[]?.bpFindings // [])] | flatten | map(select(.practiceId == $ID)) | length')"
  if [[ -z "$hits" ]]; then
    _probe_fail "$name" "jq failed to count findings"
    return 1
  fi
  if [[ "$hits" -gt 0 ]]; then
    _probe_fail "$name" "BP id '$bp_id' fired $hits time(s); expected 0"
    return 1
  fi
  return 0
}

# ---------------------------------------------------------------------------
# Probe 13 — BP finding MUST surface (companion to probe 12)
# ---------------------------------------------------------------------------
# Args: BP_ID CMD...
# Inverse of `assert_no_bp_finding_id` — asserts at least one finding
# with practiceId == BP_ID is present. Guards against a narrowing fix
# silently dropping the rule on the intent it was designed to catch.
assert_bp_finding_id_present() {
  local name="bp_finding_id_present"
  local bp_id="${1:-}"
  shift || true
  if [[ -z "$bp_id" ]]; then
    _probe_setup_fail "$name" "no BP_ID provided"
    return 2
  fi
  if [[ $# -eq 0 ]]; then
    _probe_setup_fail "$name" "no CMD provided"
    return 2
  fi
  _probe_require_jq "$name" || return 2
  local stdout envelope
  stdout="$("$@" 2>/dev/null || true)"
  envelope="$(printf '%s' "$stdout" | awk '/^\{/{block=$0; capture=1; next} capture{block=block"\n"$0} END{print block}')"
  if [[ -z "$envelope" ]] || ! printf '%s' "$envelope" | jq . >/dev/null 2>&1; then
    _probe_fail "$name" "no JSON envelope on stdout"
    return 1
  fi
  local hits
  hits="$(printf '%s' "$envelope" | jq -r --arg ID "$bp_id" \
    '[(.plan?.bpFindings // []), ((.plans // [])[]?.bpFindings // [])] | flatten | map(select(.practiceId == $ID)) | length')"
  if [[ -z "$hits" ]]; then
    _probe_fail "$name" "jq failed to count findings"
    return 1
  fi
  if [[ "$hits" -lt 1 ]]; then
    _probe_fail "$name" "BP id '$bp_id' did not fire; expected >= 1"
    return 1
  fi
  return 0
}

# End of probe library.
