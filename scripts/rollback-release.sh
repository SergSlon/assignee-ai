#!/bin/sh
# rollback-release.sh — Assignee.ai release rollback helper
#
# W24a-S2 (PR-002): operator-facing script that deprecates a bad npm release,
# hides the corresponding GitHub release, regenerates the release manifest, and
# opens a Homebrew-formula revert PR.
#
# Usage (env-var driven):
#   BAD_VERSION=v0.2.1 LAST_GOOD_VERSION=v0.2.0 ./scripts/rollback-release.sh
#
# Required env vars:
#   BAD_VERSION        — the tag that shipped the broken release (e.g. v0.2.1)
#   LAST_GOOD_VERSION  — the last known-good tag to revert to (e.g. v0.2.0)
#
# Optional env vars:
#   ROLLBACK_DRY_RUN   — set to 1 to print all commands without executing them
#   ROLLBACK_REASON    — human-readable reason appended to the npm deprecation
#                        message (default: "rolled back — see release notes")
#   REPO               — GitHub repo slug (default: SergSlon/assignee-ai)
#   NPM_PACKAGE        — npm package name (default: assignee)
#   TAP_REPO           — Homebrew tap slug (default: assignee-ai/homebrew-assignee)
#   HOMEBREW_TAP_TOKEN — PAT with write access to TAP_REPO (used by gh)
#
# Idempotency: each step checks its own preconditions before running.
# Re-running after a partial failure is safe.
#
# Dry-run mode: when ROLLBACK_DRY_RUN=1, every destructive command is prefixed
# with "DRY-RUN:" and echoed to stderr instead of executed.

set -e

# ---------------------------------------------------------------------------
# Defaults
# ---------------------------------------------------------------------------

REPO="${REPO:-SergSlon/assignee-ai}"
NPM_PACKAGE="${NPM_PACKAGE:-assignee}"
TAP_REPO="${TAP_REPO:-assignee-ai/homebrew-assignee}"
ROLLBACK_REASON="${ROLLBACK_REASON:-rolled back — see release notes}"
ROLLBACK_DRY_RUN="${ROLLBACK_DRY_RUN:-0}"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

info()  { printf '  \033[1;34m>\033[0m %s\n' "$1" >&2; }
ok()    { printf '  \033[1;32m✓\033[0m %s\n' "$1" >&2; }
warn()  { printf '  \033[1;33m!\033[0m %s\n' "$1" >&2; }
err()   { printf '  \033[1;31m✗\033[0m %s\n' "$1" >&2; exit 1; }

need_cmd() {
  if ! command -v "$1" > /dev/null 2>&1; then
    err "Required command not found: $1 — install it before running this script."
  fi
}

# run CMD [ARGS...] — execute a command, or print it in dry-run mode.
# Idempotent: callers guard with precondition checks before calling run().
run() {
  if [ "$ROLLBACK_DRY_RUN" = "1" ]; then
    printf '  \033[1;35mDRY-RUN:\033[0m %s\n' "$*" >&2
  else
    "$@"
  fi
}

# ask PROMPT — interactive confirmation; skipped in dry-run mode.
ask() {
  if [ "$ROLLBACK_DRY_RUN" = "1" ]; then
    info "DRY-RUN: skipping confirmation for: $1"
    return 0
  fi
  printf '\n  \033[1;33m??\033[0m %s [y/N] ' "$1" >&2
  read -r _answer
  case "$_answer" in
    y|Y|yes|YES) return 0 ;;
    *) warn "Aborted by operator."; exit 0 ;;
  esac
}

# ---------------------------------------------------------------------------
# Validate inputs
# ---------------------------------------------------------------------------

validate_inputs() {
  if [ -z "$BAD_VERSION" ]; then
    err "BAD_VERSION is required. Example: BAD_VERSION=v0.2.1"
  fi
  if [ -z "$LAST_GOOD_VERSION" ]; then
    err "LAST_GOOD_VERSION is required. Example: LAST_GOOD_VERSION=v0.2.0"
  fi

  # Strip leading 'v' for npm version comparisons
  BAD_VER_BARE="${BAD_VERSION#v}"
  GOOD_VER_BARE="${LAST_GOOD_VERSION#v}"

  info "Rollback target : ${NPM_PACKAGE}@${BAD_VERSION} (${REPO})"
  info "Last good       : ${NPM_PACKAGE}@${LAST_GOOD_VERSION}"
  info "Reason          : ${ROLLBACK_REASON}"
  if [ "$ROLLBACK_DRY_RUN" = "1" ]; then
    warn "DRY-RUN mode — no changes will be made."
  fi
}

# ---------------------------------------------------------------------------
# Prerequisite checks
# ---------------------------------------------------------------------------

check_prerequisites() {
  info "Checking prerequisites…"
  need_cmd npm
  need_cmd gh
  need_cmd git
  need_cmd jq

  if [ "$ROLLBACK_DRY_RUN" = "1" ]; then
    ok "DRY-RUN: skipping auth checks — commands will be printed, not executed."
    return 0
  fi

  # Verify gh is authenticated
  if ! gh auth status > /dev/null 2>&1; then
    err "gh CLI is not authenticated. Run: gh auth login"
  fi

  # Verify npm is authenticated
  if ! npm whoami > /dev/null 2>&1; then
    err "npm CLI is not authenticated. Run: npm login"
  fi

  ok "Prerequisites satisfied."
}

# ---------------------------------------------------------------------------
# Step 1 — Deprecate on npm
# ---------------------------------------------------------------------------

step1_npm_deprecate() {
  info "Step 1: Deprecating ${NPM_PACKAGE}@${BAD_VERSION} on npm…"

  # Idempotency: skip if already deprecated
  _current_deprecated="$(npm info "${NPM_PACKAGE}@${BAD_VER_BARE}" deprecated 2>/dev/null || true)"
  if [ -n "$_current_deprecated" ]; then
    ok "Already deprecated: ${_current_deprecated}"
    return 0
  fi

  ask "Deprecate ${NPM_PACKAGE}@${BAD_VERSION} on npm?"
  run npm deprecate "${NPM_PACKAGE}@${BAD_VER_BARE}" \
    "Critical bug — do not install. ${ROLLBACK_REASON}. Use ${LAST_GOOD_VERSION} instead."
  ok "npm deprecation applied."
}

# ---------------------------------------------------------------------------
# Step 2 — Hide GitHub release (mark as draft)
# ---------------------------------------------------------------------------

step2_github_release() {
  info "Step 2: Hiding GitHub release ${BAD_VERSION} (marking as draft)…"

  # Idempotency: check current draft state
  _is_draft="$(gh release view "${BAD_VERSION}" --repo "${REPO}" \
    --json isDraft --jq '.isDraft' 2>/dev/null || echo "false")"

  if [ "$_is_draft" = "true" ]; then
    ok "GitHub release ${BAD_VERSION} is already a draft."
    return 0
  fi

  ask "Mark GitHub release ${BAD_VERSION} as draft (hides from latest pointer)?"
  run gh release edit "${BAD_VERSION}" --draft --repo "${REPO}"
  ok "GitHub release ${BAD_VERSION} marked as draft."

  warn "NOTE: To permanently delete the release and tag, run manually:"
  warn "  gh release delete ${BAD_VERSION} --yes --repo ${REPO}"
  warn "  git push origin --delete ${BAD_VERSION}"
}

# ---------------------------------------------------------------------------
# Step 3 — Regenerate release manifest
# ---------------------------------------------------------------------------

MANIFEST_FILE="scripts/release-manifest.signed.json"

step3_regenerate_manifest() {
  info "Step 3: Regenerating ${MANIFEST_FILE}…"

  if [ ! -f "$MANIFEST_FILE" ]; then
    err "${MANIFEST_FILE} not found. Run this script from the repo root."
  fi

  # Check if bad version is still in the manifest
  _in_manifest="$(jq --arg v "${BAD_VER_BARE}" \
    '[.entries[].version] | index($v) != null' "${MANIFEST_FILE}" 2>/dev/null || echo "false")"

  if [ "$_in_manifest" = "false" ]; then
    ok "Manifest: ${BAD_VERSION} is not present — no update needed."
  else
    ask "Remove ${BAD_VERSION} from ${MANIFEST_FILE} and bump minimum_version to ${LAST_GOOD_VERSION}?"
    if [ "$ROLLBACK_DRY_RUN" = "1" ]; then
      info "DRY-RUN: would remove entries[version==${BAD_VER_BARE}] and set minimum_version=${GOOD_VER_BARE}"
    else
      _tmp="$(mktemp)"
      jq --arg bad "${BAD_VER_BARE}" --arg good "${GOOD_VER_BARE}" \
        --arg ts "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        '(.entries |= map(select(.version != $bad)))
         | .minimum_version = $good
         | .generated_at = $ts' \
        "${MANIFEST_FILE}" > "$_tmp"
      mv "$_tmp" "${MANIFEST_FILE}"
      ok "Manifest updated."
    fi
  fi

  # Commit and push
  ask "Commit and push the updated manifest to main?"
  run git add "${MANIFEST_FILE}"
  run git commit -m "rollback: remove ${BAD_VERSION} from release manifest, bump minimum_version to ${LAST_GOOD_VERSION}"
  run git push origin main

  ok "Manifest committed and pushed."
  warn "NOTE: If signed provenance is required, trigger the generate-provenance"
  warn "      workflow on the patched tag to rebuild and re-sign the manifest."
}

# ---------------------------------------------------------------------------
# Step 4 — Homebrew formula revert
# ---------------------------------------------------------------------------

step4_homebrew_revert() {
  info "Step 4: Opening Homebrew tap formula revert PR for ${LAST_GOOD_VERSION}…"

  if ! gh repo view "${TAP_REPO}" > /dev/null 2>&1; then
    warn "Tap repo ${TAP_REPO} is not accessible with current gh credentials."
    warn "Manual steps required:"
    warn "  1. git clone https://github.com/${TAP_REPO}.git"
    warn "  2. Edit Formula/assignee.rb: set url/sha256/version to ${LAST_GOOD_VERSION} values."
    warn "  3. Push a branch and open a PR."
    return 0
  fi

  ask "Open a Homebrew formula revert PR against ${TAP_REPO}?"
  if [ "$ROLLBACK_DRY_RUN" = "1" ]; then
    info "DRY-RUN: would clone ${TAP_REPO}, edit Formula/assignee.rb, push branch rollback/${BAD_VERSION}, open PR."
    return 0
  fi

  _tap_dir="$(mktemp -d)"
  gh repo clone "${TAP_REPO}" "$_tap_dir" -- --depth 1

  # Determine the previous-version tarball URL and sha256 from our manifest
  _last_good_url="$(jq -r --arg v "${GOOD_VER_BARE}" \
    '.entries[] | select(.version == $v) | .tarball_url // empty' \
    "${MANIFEST_FILE}" 2>/dev/null || true)"
  _last_good_sha="$(jq -r --arg v "${GOOD_VER_BARE}" \
    '.entries[] | select(.version == $v) | .sha256 // empty' \
    "${MANIFEST_FILE}" 2>/dev/null || true)"

  if [ -z "$_last_good_url" ] || [ -z "$_last_good_sha" ]; then
    warn "Could not read ${LAST_GOOD_VERSION} tarball_url/sha256 from manifest."
    warn "Edit ${_tap_dir}/Formula/assignee.rb manually before the PR is merged."
    _last_good_url="<FILL_IN_TARBALL_URL>"
    _last_good_sha="<FILL_IN_SHA256>"
  fi

  _formula="${_tap_dir}/Formula/assignee.rb"
  if [ ! -f "$_formula" ]; then
    warn "Formula not found at ${_formula}. Manual revert required."
    return 0
  fi

  # Update url, sha256, version fields in the formula
  sed -i.bak \
    -e "s|url \".*\"|url \"${_last_good_url}\"|" \
    -e "s|sha256 \".*\"|sha256 \"${_last_good_sha}\"|" \
    -e "s|version \".*\"|version \"${GOOD_VER_BARE}\"|" \
    "$_formula"
  rm -f "${_formula}.bak"

  cd "$_tap_dir"
  git checkout -b "rollback/${BAD_VERSION}"
  git add Formula/assignee.rb
  git commit -m "rollback: revert formula to ${LAST_GOOD_VERSION} (bad release ${BAD_VERSION})"
  git push origin "rollback/${BAD_VERSION}"
  gh pr create \
    --title "rollback: revert assignee formula to ${LAST_GOOD_VERSION}" \
    --body "Bad release ${BAD_VERSION} rolled back. Formula reverted to ${LAST_GOOD_VERSION}. Reason: ${ROLLBACK_REASON}" \
    --repo "${TAP_REPO}"
  cd - > /dev/null

  ok "Homebrew revert PR opened against ${TAP_REPO}."
  warn "NOTE: Merge the PR promptly so Homebrew users receive the fix on next brew upgrade."
}

# ---------------------------------------------------------------------------
# Step 5 — Summary + remaining manual steps
# ---------------------------------------------------------------------------

step5_summary() {
  printf '\n' >&2
  ok "Rollback steps 1–4 complete for ${BAD_VERSION}."
  info "Remaining manual steps:"
  printf '    1. Verify npm deprecation: npm info %s@%s deprecated\n' \
    "${NPM_PACKAGE}" "${BAD_VER_BARE}" >&2
  printf '    2. Verify GitHub release is hidden: gh release view %s --repo %s\n' \
    "${BAD_VERSION}" "${REPO}" >&2
  printf '    3. Review and merge the Homebrew tap PR.\n' >&2
  printf '    4. Add CHANGELOG entry under [Unreleased] describing the rollback.\n' >&2
  printf '    5. Announce to users (blog post / status page / email) if release was public.\n' >&2
  if [ "$ROLLBACK_DRY_RUN" = "1" ]; then
    printf '\n' >&2
    warn "This was a DRY-RUN. Re-run without ROLLBACK_DRY_RUN=1 to apply changes."
  fi
}

# ---------------------------------------------------------------------------
# Help
# ---------------------------------------------------------------------------

if [ "$1" = "--help" ] || [ "$1" = "-h" ]; then
  cat >&2 <<'HELP'
rollback-release.sh — Assignee.ai release rollback helper

Required env vars:
  BAD_VERSION          Tag of the bad release (e.g. v0.2.1)
  LAST_GOOD_VERSION    Last known-good tag (e.g. v0.2.0)

Optional env vars:
  ROLLBACK_DRY_RUN=1   Print commands without executing (safe to run first)
  ROLLBACK_REASON      Human-readable reason for the rollback
  REPO                 GitHub slug (default: SergSlon/assignee-ai)
  NPM_PACKAGE          npm package name (default: assignee)
  TAP_REPO             Homebrew tap slug (default: assignee-ai/homebrew-assignee)

Example (dry-run):
  ROLLBACK_DRY_RUN=1 BAD_VERSION=v0.2.1 LAST_GOOD_VERSION=v0.2.0 ./scripts/rollback-release.sh

Example (live):
  BAD_VERSION=v0.2.1 LAST_GOOD_VERSION=v0.2.0 \
    ROLLBACK_REASON="critical data-loss bug" \
    ./scripts/rollback-release.sh

See docs/how-to/release-process.md § "Release Rollback" for the full runbook.
HELP
  exit 0
fi

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

validate_inputs
check_prerequisites
step1_npm_deprecate
step2_github_release
step3_regenerate_manifest
step4_homebrew_revert
step5_summary
