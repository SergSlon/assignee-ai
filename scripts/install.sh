#!/bin/sh
# Assignee.ai installer
# Usage: curl -sSL https://install.assignee.ai | sh
#
# Detects OS and architecture, downloads the appropriate release binary,
# and installs it to ~/.local/bin (or /usr/local/bin with sudo).

set -e

REPO="assignee-ai/assignee"
INSTALL_DIR="${ASSIGNEE_INSTALL_DIR:-$HOME/.local/bin}"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

info()  { printf '  \033[1;34m>\033[0m %s\n' "$1"; }
ok()    { printf '  \033[1;32m✓\033[0m %s\n' "$1"; }
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
  trap 'rm -rf "$TMPDIR"' EXIT

  info "Downloading ${URL}..."
  curl -sSL -o "${TMPDIR}/${TARBALL}" "$URL"

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
  else
    err "Binary not found in archive"
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
  download_and_install
  check_path
  verify_install

  echo ""
  ok "Installation complete! Run 'assignee --help' to get started."
  echo ""
}

main
