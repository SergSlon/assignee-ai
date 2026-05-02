#!/bin/sh
# Assignee.ai installer
# Usage: curl -sSL https://install.assignee.ai | sh
#
# Detects OS and architecture, downloads the appropriate release binary,
# and installs it to ~/.local/bin (or /usr/local/bin with sudo).
#
# W7-02: SHA256 verification + version allowlist guard.
# - The manifest at MANIFEST_URL lists known-good releases with their SHA256
#   hashes and a minimum_version floor.
# - If ASSIGNEE_VERSION is set, it must appear in the manifest (unless
#   ASSIGNEE_DOWNGRADE_ACK=1 is also set for an explicit downgrade).
# - After download, the tarball's SHA256 is checked against the manifest
#   before extraction. Mismatch → instant abort (MITM / corruption guard).

set -e

REPO="SergSlon/assignee-ai"
INSTALL_DIR="${ASSIGNEE_INSTALL_DIR:-$HOME/.local/bin}"
# Manifest is fetched from the release asset (not raw.githubusercontent.com) so
# it reflects the exact signed manifest that shipped with the version being installed.
# install.sh sets MANIFEST_URL after VERSION is resolved (see resolve_version).
MANIFEST_URL=""

# ---------------------------------------------------------------------------
# Unified cleanup — a single EXIT trap so both temporaries are always removed.
# We track each temp path in a variable and clean up both in one handler.
# This avoids the POSIX sh limitation where the second `trap … EXIT` silently
# replaces the first, leaking the manifest temp file on err() paths.
# ---------------------------------------------------------------------------

MANIFEST_FILE=""
TMPDIR=""

cleanup() {
  [ -n "$MANIFEST_FILE" ] && rm -f "$MANIFEST_FILE"
  [ -n "$TMPDIR" ]        && rm -rf "$TMPDIR"
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
# Helpers
# All installer output goes to stderr; stdout is reserved for data.
# ---------------------------------------------------------------------------

info()  { printf '  \033[1;34m>\033[0m %s\n' "$1" >&2; }
ok()    { printf '  \033[1;32m✓\033[0m %s\n' "$1" >&2; }
warn()  { printf '  \033[1;33m!\033[0m %s\n' "$1" >&2; }
err()   { printf '  \033[1;31m✗\033[0m %s\n' "$1" >&2; exit 1; }

need_cmd() {
  if ! command -v "$1" > /dev/null 2>&1; then
    err "Required command not found: $1"
  fi
}

# ---------------------------------------------------------------------------
# Detect OS / Arch
# ---------------------------------------------------------------------------

detect_platform() {
  OS="$(uname -s)"
  ARCH="$(uname -m)"

  case "$OS" in
    Darwin) OS="darwin" ;;
    Linux)  OS="linux"  ;;
    *)      err "Unsupported operating system: $OS" ;;
  esac

  case "$ARCH" in
    x86_64|amd64)  ARCH="x64"   ;;
    arm64|aarch64) ARCH="arm64" ;;
    *)             err "Unsupported architecture: $ARCH" ;;
  esac

  PLATFORM="${OS}-${ARCH}"
  info "Detected platform: ${PLATFORM}"
}

# ---------------------------------------------------------------------------
# Node.js version check
#
# Reads the minimum Node.js version from the bundled package.json
# `engines.node` field (e.g. ">=20.11") and aborts with an actionable
# message if the running node binary does not meet it.
#
# Arguments:
#   $1 — path to the extracted package.json (TMPDIR/package.json)
#
# POSIX sh-compatible. Silently skips if node is absent or package.json
# cannot be parsed (the later binary-not-found check will catch bad archives).
# ---------------------------------------------------------------------------

check_node_version() {
  PKG_JSON="$1"

  if ! command -v node > /dev/null 2>&1; then
    return
  fi

  if [ ! -f "$PKG_JSON" ]; then
    return
  fi

  # Extract minimum numeric floor from engines.node (e.g. ">=20.11" → "20.11")
  ENGINES_NODE=$(node -e "
    try {
      var p = JSON.parse(require('fs').readFileSync('$PKG_JSON', 'utf8'));
      var eng = (p.engines && p.engines.node) ? p.engines.node : '';
      // strip leading >=, >, ~, ^ and whitespace; keep first semver token
      var m = eng.replace(/^[>=<~^\\s]+/, '').split(/\\s/)[0];
      if (m) process.stdout.write(m);
    } catch(e) {}
  " 2>/dev/null || true)

  if [ -z "$ENGINES_NODE" ]; then
    return
  fi

  # Compare: split into major.minor components, compare numerically
  REQUIRED_MAJOR=$(echo "$ENGINES_NODE" | cut -d. -f1)
  REQUIRED_MINOR=$(echo "$ENGINES_NODE" | cut -d. -f2)
  REQUIRED_MINOR="${REQUIRED_MINOR:-0}"

  ACTUAL_NODE_VERSION=$(node --version 2>/dev/null | sed 's/^v//')
  ACTUAL_MAJOR=$(echo "$ACTUAL_NODE_VERSION" | cut -d. -f1)
  ACTUAL_MINOR=$(echo "$ACTUAL_NODE_VERSION" | cut -d. -f2)
  ACTUAL_MINOR="${ACTUAL_MINOR:-0}"

  if [ -z "$ACTUAL_MAJOR" ]; then
    return
  fi

  MEETS_REQ=1
  if [ "$ACTUAL_MAJOR" -lt "$REQUIRED_MAJOR" ] 2>/dev/null; then
    MEETS_REQ=0
  elif [ "$ACTUAL_MAJOR" -eq "$REQUIRED_MAJOR" ] 2>/dev/null; then
    if [ "$ACTUAL_MINOR" -lt "$REQUIRED_MINOR" ] 2>/dev/null; then
      MEETS_REQ=0
    fi
  fi

  if [ "$MEETS_REQ" = "0" ]; then
    err "Node.js >= ${ENGINES_NODE} is required to run assignee.
  Found:    node v${ACTUAL_NODE_VERSION}
  Required: node >= ${ENGINES_NODE} (from package.json engines.node)

  Update Node.js at https://nodejs.org/ (LTS recommended: v22.x)"
  fi

  ok "Node.js v${ACTUAL_NODE_VERSION} meets requirement >= ${ENGINES_NODE}"
}

# ---------------------------------------------------------------------------
# SHA256 utility (cross-platform: shasum on macOS, sha256sum on Linux)
# ---------------------------------------------------------------------------

sha256_file() {
  if command -v sha256sum > /dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  elif command -v shasum > /dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    err "No SHA256 utility found (need sha256sum or shasum)"
  fi
}

# ---------------------------------------------------------------------------
# Fetch and parse the release manifest
# ---------------------------------------------------------------------------

fetch_manifest() {
  need_cmd curl

  info "Fetching release manifest..."
  # MANIFEST_FILE is declared at script top; global cleanup() trap handles removal.
  MANIFEST_FILE="$(mktemp)"

  if ! curl -sSL --proto '=https' --tlsv1.2 --max-redirs 5 -o "$MANIFEST_FILE" "$MANIFEST_URL" 2>/dev/null; then
    warn "Could not fetch release manifest from ${MANIFEST_URL}"
    warn "SHA256 verification will be skipped — install at your own risk."
    MANIFEST_FILE=""
    return
  fi

  # Basic sanity check: manifest must contain an entries array
  if ! grep -q '"entries"' "$MANIFEST_FILE" 2>/dev/null; then
    warn "Release manifest appears malformed — SHA256 verification will be skipped."
    MANIFEST_FILE=""
  fi
}

# ---------------------------------------------------------------------------
# Look up the expected SHA256 for this version + platform in the manifest
# ---------------------------------------------------------------------------

lookup_sha256() {
  if [ -z "$MANIFEST_FILE" ]; then
    EXPECTED_SHA256=""
    return
  fi

  TARBALL_NAME="assignee-${VERSION}-${PLATFORM}.tar.gz"

  # Parse the JSON manifest with a portable node invocation.
  # Falls back gracefully if node is not available.
  if command -v node > /dev/null 2>&1; then
    EXPECTED_SHA256=$(node -e "
      try {
        const m = JSON.parse(require('fs').readFileSync('${MANIFEST_FILE}', 'utf8'));
        const entry = (m.entries || []).find(e => e.filename === '${TARBALL_NAME}');
        if (entry && entry.sha256) {
          process.stdout.write(entry.sha256);
        }
      } catch(e) {}
    " 2>/dev/null || echo "")
  else
    EXPECTED_SHA256=""
    warn "node not available — SHA256 lookup skipped."
  fi

  if [ -n "$EXPECTED_SHA256" ]; then
    info "Expected SHA256: ${EXPECTED_SHA256}"
  fi
}

# ---------------------------------------------------------------------------
# SEC-032: Log ASSIGNEE_DOWNGRADE_ACK bypass to a tamper-evident local trail.
# Appends a timestamped record to ~/.assignee/install-bypasses.log so that
# security audits can detect when the version allowlist was deliberately bypassed.
# ---------------------------------------------------------------------------

log_downgrade_bypass() {
  _bypass_reason="$1"
  _bypass_log="${HOME}/.assignee/install-bypasses.log"
  mkdir -p "${HOME}/.assignee"
  # Append timestamp + version + reason; failure is non-fatal but warned.
  if printf '%s ASSIGNEE_DOWNGRADE_ACK version=%s reason="%s"\n' \
      "$(date -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || date '+%Y-%m-%dT%H:%M:%SZ')" \
      "${VERSION}" \
      "${_bypass_reason}" >> "$_bypass_log" 2>/dev/null; then
    chmod 0600 "$_bypass_log" 2>/dev/null || true
    warn "Bypass recorded in ${_bypass_log}"
  else
    warn "Could not write bypass record to ${_bypass_log} — proceeding anyway."
  fi
}

# ---------------------------------------------------------------------------
# Version allowlist check
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# semver_lt A B  — returns 0 (true) if semver A < semver B, using only POSIX sh.
# Compares major.minor.patch numerically; strips leading 'v' from both args.
# Pre-release suffixes (e.g. -rc.1) are ignored — only the numeric release
# portion is compared (conservative: a pre-release is treated as its base version).
# ---------------------------------------------------------------------------

semver_lt() {
  # Strip leading 'v' and pre-release suffix, then extract numeric components.
  _a=$(printf '%s' "$1" | sed 's/^v//;s/-.*//')
  _b=$(printf '%s' "$2" | sed 's/^v//;s/-.*//')

  _a_maj=$(printf '%s' "$_a" | cut -d. -f1); _a_maj="${_a_maj:-0}"
  _a_min=$(printf '%s' "$_a" | cut -d. -f2); _a_min="${_a_min:-0}"
  _a_pat=$(printf '%s' "$_a" | cut -d. -f3); _a_pat="${_a_pat:-0}"

  _b_maj=$(printf '%s' "$_b" | cut -d. -f1); _b_maj="${_b_maj:-0}"
  _b_min=$(printf '%s' "$_b" | cut -d. -f2); _b_min="${_b_min:-0}"
  _b_pat=$(printf '%s' "$_b" | cut -d. -f3); _b_pat="${_b_pat:-0}"

  if [ "$_a_maj" -lt "$_b_maj" ] 2>/dev/null; then return 0; fi
  if [ "$_a_maj" -gt "$_b_maj" ] 2>/dev/null; then return 1; fi
  # majors equal — compare minor
  if [ "$_a_min" -lt "$_b_min" ] 2>/dev/null; then return 0; fi
  if [ "$_a_min" -gt "$_b_min" ] 2>/dev/null; then return 1; fi
  # minors equal — compare patch
  if [ "$_a_pat" -lt "$_b_pat" ] 2>/dev/null; then return 0; fi
  return 1
}

check_version_allowlist() {
  if [ -z "$MANIFEST_FILE" ]; then
    return
  fi

  if ! command -v node > /dev/null 2>&1; then
    return
  fi

  # Read minimum_version from manifest
  MINIMUM_VERSION=$(node -e "
    try {
      const m = JSON.parse(require('fs').readFileSync('${MANIFEST_FILE}', 'utf8'));
      if (m.minimum_version) process.stdout.write(m.minimum_version);
    } catch(e) {}
  " 2>/dev/null || echo "")

  if [ -z "$MINIMUM_VERSION" ]; then
    return
  fi

  # ── PR-001: enforce the minimum-version floor ────────────────────────────
  # Compare VERSION against MINIMUM_VERSION using POSIX sh (no node/bc).
  # Strip the leading 'v' from VERSION for comparison (manifest stores bare semver).
  VERSION_BARE=$(printf '%s' "${VERSION}" | sed 's/^v//')
  if semver_lt "$VERSION_BARE" "$MINIMUM_VERSION"; then
    if [ "${ASSIGNEE_DOWNGRADE_ACK:-}" = "1" ]; then
      warn "ASSIGNEE_DOWNGRADE_ACK=1 set — installing version ${VERSION} below minimum ${MINIMUM_VERSION}."
      warn "This bypasses the version floor. Proceed with caution."
      log_downgrade_bypass "version-below-minimum: ${VERSION} < ${MINIMUM_VERSION}"
    else
      err "Version ${VERSION} is below the minimum allowed version ${MINIMUM_VERSION}.
  This version has been removed from the release allowlist (e.g. critical security fix).
  Install the latest version instead, or set ASSIGNEE_DOWNGRADE_ACK=1 if you understand the risk:
    ASSIGNEE_DOWNGRADE_ACK=1 ASSIGNEE_VERSION=${VERSION} sh install.sh"
    fi
  fi

  # Check if the requested version is in the manifest's entries
  IS_KNOWN=$(node -e "
    try {
      const m = JSON.parse(require('fs').readFileSync('${MANIFEST_FILE}', 'utf8'));
      const version = '${VERSION}';
      const known = (m.entries || []).some(e => e.version === version || e.filename.includes(version));
      // Also accept if version equals the manifest's own version field
      const isManifestVersion = m.version === version;
      process.stdout.write(known || isManifestVersion ? 'yes' : 'no');
    } catch(e) {
      process.stdout.write('unknown');
    }
  " 2>/dev/null || echo "unknown")

  if [ "$IS_KNOWN" = "unknown" ]; then
    warn "Could not determine if version ${VERSION} is in the allowlist."
    return
  fi

  if [ "$IS_KNOWN" = "no" ]; then
    # Version is not in the manifest — check for downgrade ack
    if [ "${ASSIGNEE_DOWNGRADE_ACK:-}" = "1" ]; then
      warn "ASSIGNEE_DOWNGRADE_ACK=1 set — installing unverified version ${VERSION}."
      warn "This bypasses the version allowlist. Proceed with caution."
      log_downgrade_bypass "version-not-in-allowlist: ${VERSION}"
    else
      err "Version ${VERSION} is not in the release allowlist.
  This could mean:
    1. It is a pre-release not yet published in the manifest
    2. It is a known-vulnerable version that has been removed from the allowlist
    3. The version string is misspelled
  If you need this specific version and understand the risk, re-run with:
    ASSIGNEE_DOWNGRADE_ACK=1 ASSIGNEE_VERSION=${VERSION} sh install.sh"
    fi
  fi
}

# ---------------------------------------------------------------------------
# Resolve latest version
# ---------------------------------------------------------------------------

resolve_version() {
  need_cmd curl

  VERSION="${ASSIGNEE_VERSION:-}"
  if [ -z "$VERSION" ]; then
    info "Fetching latest release..."
    VERSION="$(curl -sSL --proto '=https' --tlsv1.2 --max-redirs 5 "https://api.github.com/repos/${REPO}/releases/latest" \
      | grep '"tag_name"' \
      | head -1 \
      | sed 's/.*"tag_name": *"//;s/".*//')"
  fi

  if [ -z "$VERSION" ]; then
    err "Could not determine latest version"
  fi

  info "Version: ${VERSION}"

  # ── S1/PR-010: Manifest is fetched from the release asset, not from
  # raw.githubusercontent.com/…/main/…, so install.sh always reads the
  # signed manifest that was published alongside the tarball — not a
  # potentially stale placeholder in the main branch.
  MANIFEST_URL="https://github.com/${REPO}/releases/download/${VERSION}/release-manifest.signed.json"
}

# ---------------------------------------------------------------------------
# Download & install
# ---------------------------------------------------------------------------

download_and_install() {
  TARBALL="assignee-${VERSION}-${PLATFORM}.tar.gz"
  URL="https://github.com/${REPO}/releases/download/${VERSION}/${TARBALL}"
  # Redact any query-string from the URL before using it in user-visible messages
  # (credentials/tokens embedded as query params must never appear in error output).
  SAFE_URL=$(printf '%s' "${URL}" | sed 's/\?.*//')

  # TMPDIR is declared at script top; global cleanup() trap handles removal.
  TMPDIR="$(mktemp -d)"

  # ASSIGNEE_LOCAL_TARBALL allows CI / test environments to supply an already-
  # downloaded tarball and skip the network download entirely.
  # SEC-033: When a local tarball is supplied, the manifest MUST have been fetched
  # and EXPECTED_SHA256 MUST be non-empty.  Skipping the network download must not
  # also skip the trust check — a CI pipeline that sets ASSIGNEE_LOCAL_TARBALL is
  # still responsible for ensuring the tarball matches the release manifest.
  if [ -n "${ASSIGNEE_LOCAL_TARBALL:-}" ]; then
    if [ ! -f "$ASSIGNEE_LOCAL_TARBALL" ]; then
      err "ASSIGNEE_LOCAL_TARBALL set but file not found: ${ASSIGNEE_LOCAL_TARBALL}"
    fi
    if [ -z "${EXPECTED_SHA256:-}" ]; then
      err "ASSIGNEE_LOCAL_TARBALL is set but SHA256 verification cannot be performed.
  The release manifest was unavailable or could not be parsed (node may be absent).
  A local tarball without manifest verification provides no supply-chain protection.
  Ensure the manifest is reachable and node is installed before using ASSIGNEE_LOCAL_TARBALL."
    fi
    info "Using local tarball: ${ASSIGNEE_LOCAL_TARBALL}"
    cp "$ASSIGNEE_LOCAL_TARBALL" "${TMPDIR}/${TARBALL}"
  else
    need_cmd curl
    info "Downloading ${SAFE_URL}..."
    if ! curl -sSL --proto '=https' --tlsv1.2 --max-redirs 5 -o "${TMPDIR}/${TARBALL}" "$URL"; then
      err "Download failed — check that ${SAFE_URL} exists and you have network connectivity."
    fi
  fi

  # ── W7-02: SHA256 verification ────────────────────────────────────────────
  ACTUAL_SHA256="$(sha256_file "${TMPDIR}/${TARBALL}")"
  info "Actual SHA256:   ${ACTUAL_SHA256}"

  if [ -n "${EXPECTED_SHA256:-}" ]; then
    if [ "$ACTUAL_SHA256" != "$EXPECTED_SHA256" ]; then
      err "SHA256 mismatch!
  Expected: ${EXPECTED_SHA256}
  Actual:   ${ACTUAL_SHA256}

  The downloaded tarball does not match the release manifest.
  This could indicate a MITM attack, a CDN corruption, or a race condition
  during a release update. Do NOT install this artefact.

  Please retry the download. If the mismatch persists, open an issue at
  https://github.com/${REPO}/issues
  (download URL: ${SAFE_URL})"
    fi
    ok "SHA256 verified: ${ACTUAL_SHA256}"
  else
    # SEC-013: Fail-closed — never install without SHA256 verification.
    # A missing EXPECTED_SHA256 means either the manifest was unavailable or node
    # was absent (needed to parse the manifest JSON).  Either condition is a trust
    # failure: we cannot authenticate the tarball, so we must refuse to install.
    err "FATAL: SHA256 verification required but could not be performed.
  The release manifest was unavailable or could not be parsed (node may be absent).
  Refusing to install an unverified tarball to protect against supply-chain attacks.

  To resolve:
    1. Ensure 'node' is installed before running the installer, OR
    2. Retry — a transient network error may have prevented manifest fetch.
  (download URL: ${SAFE_URL})"
  fi

  info "Extracting..."
  tar -xzf "${TMPDIR}/${TARBALL}" -C "$TMPDIR"

  # Create install directory if needed
  mkdir -p "$INSTALL_DIR"

  # Install the binary
  if [ -f "${TMPDIR}/assignee" ]; then
    cp "${TMPDIR}/assignee" "${INSTALL_DIR}/assignee"
    chmod +x "${INSTALL_DIR}/assignee"
  elif [ -f "${TMPDIR}/bin/assignee" ]; then
    cp "${TMPDIR}/bin/assignee" "${INSTALL_DIR}/assignee"
    chmod +x "${INSTALL_DIR}/assignee"
  elif [ -f "${TMPDIR}/dist/index.js" ]; then
    # pnpm deploy tarball layout: dist/ + node_modules/ + package.json
    # Create a wrapper script that invokes the bundled dist/index.js
    if ! command -v node > /dev/null 2>&1; then
      err "Node.js is required to run assignee but was not found.
  Install Node.js LTS (v22.x recommended) at https://nodejs.org/"
    fi
    # Validate the running Node.js version against the bundled engines.node field.
    check_node_version "${TMPDIR}/package.json"
    mkdir -p "${INSTALL_DIR}"
    LIBEXEC_DIR="${HOME}/.assignee/libexec/${VERSION}"
    mkdir -p "$LIBEXEC_DIR"
    cp -r "${TMPDIR}/." "$LIBEXEC_DIR/"
    # Restrict libexec directory to owner-only — node_modules may contain files
    # with elevated permissions from the tarball; deny group/other read+write+exec.
    chmod -R go-rwx "$LIBEXEC_DIR"
    # SEC-015: Write wrapper atomically — write to a temp file, chmod, then mv.
    # This prevents a race between the cat/write and the chmod where an attacker
    # could replace the file with a symlink (e.g. to /etc/sudoers) before chmod runs.
    WRAPPER_TMP="${INSTALL_DIR}/assignee.tmp.$$"
    cat > "$WRAPPER_TMP" <<WRAPPER
#!/bin/sh
exec node "${LIBEXEC_DIR}/dist/index.js" "\$@"
WRAPPER
    chmod +x "$WRAPPER_TMP"
    mv "$WRAPPER_TMP" "${INSTALL_DIR}/assignee"
  else
    err "Binary not found in archive. Expected: assignee, bin/assignee, or dist/index.js"
  fi

  ok "Installed assignee to ${INSTALL_DIR}/assignee"
}

# ---------------------------------------------------------------------------
# PATH check
# ---------------------------------------------------------------------------

check_path() {
  case ":$PATH:" in
    *":${INSTALL_DIR}:"*) ;;
    *)
      echo ""
      info "Add assignee to your PATH by adding this to your shell profile:"
      echo ""
      echo "    export PATH=\"${INSTALL_DIR}:\$PATH\""
      echo ""
      SHELL_NAME="$(basename "$SHELL" 2>/dev/null || echo "sh")"
      case "$SHELL_NAME" in
        zsh)  info "Add to ~/.zshrc" ;;
        bash) info "Add to ~/.bashrc or ~/.bash_profile" ;;
        fish) info "Run: set -Ux fish_user_paths ${INSTALL_DIR} \$fish_user_paths" ;;
      esac
      ;;
  esac
}

# ---------------------------------------------------------------------------
# Verify installation
# ---------------------------------------------------------------------------

verify_install() {
  if [ -x "${INSTALL_DIR}/assignee" ]; then
    INSTALLED_VERSION="$("${INSTALL_DIR}/assignee" --version 2>/dev/null || echo "unknown")"
    ok "assignee ${INSTALLED_VERSION} is ready"
  else
    err "Installation verification failed"
  fi
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

main() {
  echo ""
  echo "  Assignee.ai Installer"
  echo "  ====================="
  echo ""

  detect_platform
  resolve_version
  fetch_manifest
  check_version_allowlist
  lookup_sha256
  download_and_install
  check_path
  verify_install

  echo ""
  ok "Installation complete! Run 'assignee --help' to get started."
  echo ""
}

main
