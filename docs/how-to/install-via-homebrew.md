# Install Assignee.ai via Homebrew

This guide covers installing the Assignee.ai CLI using Homebrew on macOS or
Linux. The Homebrew formula is cryptographically verified — the SHA256 of
every release tarball is checked against the
[release manifest](../../scripts/release-manifest.signed.json) before
installation begins.

## Prerequisites

- [Homebrew](https://brew.sh/) 4.0 or later
- macOS 13+ (Intel or Apple Silicon) or Linux (x86-64 or ARM64)
- Node.js 22 (Homebrew installs this automatically as a dependency)

## Installation

```sh
# 1. Add the Assignee.ai tap
brew tap SergSlon/assignee-ai

# 2. Install
brew install assignee

# 3. Verify
assignee --version
```

## What happens during install

When you run `brew install assignee`, Homebrew:

1. Downloads the platform-specific release tarball
   (e.g. `assignee-v0.1.0-darwin-arm64.tar.gz`) from the GitHub release page.
2. Verifies the tarball's SHA256 against the value embedded in the formula.
   This SHA256 comes from the release manifest generated at release time —
   the Homebrew formula update step asserts the formula hash matches the
   manifest before committing.
3. Extracts the tarball into `libexec/`. Because the tarball is produced by
   `pnpm deploy --prod`, it contains a self-contained `node_modules/` tree
   with all runtime dependencies — no network calls at first run.
4. Creates a thin wrapper at `bin/assignee` that calls
   `node <libexec>/dist/index.js "$@"` using the Homebrew-managed Node.js.

## Verifying the installation independently

After installation, you can independently verify the tarball matches the
release provenance attestation:

```sh
# 1. Install cosign
brew install cosign

# 2. Determine your installed version
VERSION=$(assignee --version | awk '{print $NF}')
PLATFORM="darwin-arm64"  # or darwin-x64

# 3. Download the signing certificate and signature from the release
BASE_URL="https://github.com/SergSlon/assignee-ai/releases/download/v${VERSION}"
TARBALL="assignee-v${VERSION}-${PLATFORM}.tar.gz"

curl -LO "${BASE_URL}/${TARBALL}"
curl -LO "${BASE_URL}/${TARBALL}.pem"
curl -LO "${BASE_URL}/${TARBALL}.sig"

# 4. Verify
cosign verify-blob \
  --certificate "${TARBALL}.pem" \
  --signature "${TARBALL}.sig" \
  --certificate-identity "https://github.com/SergSlon/assignee-ai/.github/workflows/release.yml@refs/heads/main" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  "${TARBALL}"
```

`Verified OK` means the tarball was produced by the official Assignee.ai
release workflow on GitHub's infrastructure. See
[`supply-chain-provenance.md`](../explanation/supply-chain-provenance.md)
for the full verification guide.

## Upgrading

```sh
brew update
brew upgrade assignee
```

## Uninstalling

```sh
brew uninstall assignee
brew untap SergSlon/assignee-ai  # optional — removes the tap too
```

## Private tap / pre-public-release install

The Homebrew tap is **not yet public** — `ASSIGNEE_TAP_PUBLISH=1` must be
flipped by the acquirer post-go-decision before `brew tap SergSlon/assignee-ai`
works for end users (see `docs/how-to/release-process.md`).

Until the tap is public, install from source or use the pre-built tarball:

### Install from tarball (pre-release testing)

```sh
# 1. Download the linux/macOS tarball from the GitHub release page (or CI artefacts)
VERSION="v0.1.0"
PLATFORM="darwin-arm64"   # or darwin-x64 / linux-x64 / linux-arm64
TARBALL="assignee-${VERSION}-${PLATFORM}.tar.gz"

# 2. Extract
mkdir -p ~/opt/assignee
tar -xzf "${TARBALL}" -C ~/opt/assignee

# 3. Create a wrapper (requires node@22 on PATH)
cat > /usr/local/bin/assignee <<'SH'
#!/bin/bash
exec node ~/opt/assignee/dist/index.js "$@"
SH
chmod +x /usr/local/bin/assignee

# 4. Verify
assignee --version
```

### Formula template

The formula template at `homebrew/assignee.rb` uses `$VERSION` and `$SHA_*`
placeholders rendered by the `update-homebrew` CI job. The template is
committed to the main repo; the rendered formula lives in the
`assignee-ai/homebrew-assignee` tap repo (not yet public).

To test the formula template locally with a specific build:

```sh
# Compute real sha256 for your local tarball first
sha256sum assignee-v0.1.0-darwin-arm64.tar.gz

# Then install directly from the formula file
brew install --formula homebrew/assignee.rb
```

Note: `brew install --formula <local-path>` skips the tap repo entirely.
Use this for pre-release QA only.

## Troubleshooting

### `Error: No available formula with the name "assignee"`

The tap is not added yet (or not yet public). Run `brew tap SergSlon/assignee-ai` first.
If the tap is not yet public, use the tarball install path above.

### `SHA256 mismatch`

This should never happen with a clean install. If it does:

1. Run `brew update` to refresh the tap formula.
2. If the error persists, the CDN may be serving a cached old artefact.
   Wait 15 minutes and retry.
3. If still failing, open an issue at https://github.com/SergSlon/assignee-ai/issues

### `node: command not found` inside the wrapper

The formula declares `depends_on "node@22"`. If Homebrew's Node.js is
unlinked, run `brew link node@22` and retry.

### The CLI crashes on import (`Cannot find package '@ai-sdk/...'`)

This indicates a tarball without bundled `node_modules`. The release pipeline
uses `pnpm deploy --prod` to guarantee a self-contained tarball. If you see
this, file a bug — it means the tarball was produced incorrectly.
