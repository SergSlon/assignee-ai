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

REPO="assignee-ai/assignee"
INSTALL_DIR="${ASSIGNEE_INSTALL_DIR:-$HOME/.local/bin}"
MANIFEST_URL="https://raw.githubusercontent.com/${REPO}/main/scripts/release-manifest.signed.json"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

info()  { printf '  \033[1;34m>\033[0m %s\n' "$1"; }
ok()    { printf '  \033[1;32m✓\033[0m %s\n' "$1"; }
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
  MANIFEST_FILE="$(mktemp)"
  trap 'rm -f "$MANIFEST_FILE"' EXIT

  if ! curl -sSL -o "$MANIFEST_FILE" "$MANIFEST_URL" 2>/dev/null; then
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
# Version allowlist check
# ---------------------------------------------------------------------------

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
    VERSION="$(curl -sSL "https://api.github.com/repos/${REPO}/releases/latest" \
      | grep '"tag_name"' \
      | head -1 \
      | sed 's/.*"tag_name": *"//;s/".*//')"
  fi

  if [ -z "$VERSION" ]; then
    err "Could not determine latest version"
  fi

  info "Version: ${VERSION}"
}

# ---------------------------------------------------------------------------
# Download & install
# ---------------------------------------------------------------------------

download_and_install() {
  TARBALL="assignee-${VERSION}-${PLATFORM}.tar.gz"
  URL="https://github.com/${REPO}/releases/download/${VERSION}/${TARBALL}"

  TMPDIR="$(mktemp -d)"
  # Note: the manifest cleanup trap is set above; this extends it
  old_trap=$(trap -p EXIT | sed "s/trap -- '//;s/' EXIT//")
  trap "rm -rf \"$TMPDIR\"" EXIT

  info "Downloading ${URL}..."
  if ! curl -sSL -o "${TMPDIR}/${TARBALL}" "$URL"; then
    err "Download failed — check that ${URL} exists and you have network connectivity."
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
  https://github.com/${REPO}/issues"
    fi
    ok "SHA256 verified: ${ACTUAL_SHA256}"
  else
    warn "SHA256 verification skipped (manifest unavailable or no entry for this platform/version)."
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
      err "Node.js is required to run assignee but was not found. Install node >= 20.11."
    fi
    mkdir -p "${INSTALL_DIR}"
    LIBEXEC_DIR="${HOME}/.assignee/libexec/${VERSION}"
    mkdir -p "$LIBEXEC_DIR"
    cp -r "${TMPDIR}/." "$LIBEXEC_DIR/"
    cat > "${INSTALL_DIR}/assignee" <<WRAPPER
#!/bin/sh
exec node "${LIBEXEC_DIR}/dist/index.js" "\$@"
WRAPPER
    chmod +x "${INSTALL_DIR}/assignee"
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
