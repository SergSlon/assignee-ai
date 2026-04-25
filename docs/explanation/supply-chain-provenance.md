# Supply-Chain Provenance (SLSA L2)

## Overview

Every Assignee.ai release is cryptographically signed using
[cosign](https://github.com/sigstore/cosign) via GitHub's OIDC identity
provider. The resulting provenance attestation ties the release tarball to the
exact workflow run that produced it, satisfying **SLSA Level 2** requirements
and the signing mandate from **US Executive Order 14028**.

The signing certificate is anchored to the GitHub Actions workflow identity —
no long-lived signing keys are used. Verification requires only:

- The tarball (or its digest)
- The workflow identity URL and OIDC issuer (both public, listed below)

## Provenance artefacts

Each GitHub release includes, alongside the tarballs:

| File                                       | Description                               |
| ------------------------------------------ | ----------------------------------------- |
| `assignee-<version>-<platform>.tar.gz`     | The release tarball                       |
| `assignee-<version>-<platform>.tar.gz.pem` | Signing certificate (OIDC-bound)          |
| `assignee-<version>-<platform>.tar.gz.sig` | cosign signature                          |
| `assignee-<version>-sbom.spdx.json`        | SPDX SBOM (see `sbom.md`)                 |
| `scripts/release-manifest.signed.json`     | SHA256 manifest for install.sh + Homebrew |

## Verifying a tarball

### Prerequisites

```sh
# Install cosign (macOS)
brew install cosign

# Install cosign (Linux)
curl -sSLO https://github.com/sigstore/cosign/releases/latest/download/cosign-linux-amd64
chmod +x cosign-linux-amd64
sudo mv cosign-linux-amd64 /usr/local/bin/cosign
```

### Verify a specific release

```sh
VERSION="v0.1.0"
PLATFORM="darwin-arm64"   # or darwin-x64 / linux-x64 / linux-arm64

TARBALL="assignee-${VERSION}-${PLATFORM}.tar.gz"
CERT="assignee-${VERSION}-${PLATFORM}.tar.gz.pem"
SIG="assignee-${VERSION}-${PLATFORM}.tar.gz.sig"

# Download all three files from the GitHub release
curl -LO "https://github.com/assignee-ai/assignee/releases/download/${VERSION}/${TARBALL}"
curl -LO "https://github.com/assignee-ai/assignee/releases/download/${VERSION}/${CERT}"
curl -LO "https://github.com/assignee-ai/assignee/releases/download/${VERSION}/${SIG}"

# Verify the signature
cosign verify-blob \
  --certificate "${CERT}" \
  --signature "${SIG}" \
  --certificate-identity "https://github.com/assignee-ai/assignee/.github/workflows/release.yml@refs/heads/main" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  "${TARBALL}"
```

A successful verification prints:

```
Verified OK
```

### What is being verified?

The `--certificate-identity` value asserts that the signing certificate was
issued to the exact GitHub Actions workflow file path listed. Any tarball
signed by a different workflow, a different branch, or a different repository
will fail verification.

The `--certificate-oidc-issuer` asserts that GitHub's OIDC provider issued the
certificate (not a third-party token service).

Together these constraints mean: **this tarball was built by the official
Assignee.ai release workflow, running on GitHub's infrastructure, from the
`main` branch**.

## How provenance is generated

The `generate-provenance` job in `.github/workflows/release.yml.disabled`:

1. Downloads all four platform tarballs from the GitHub Actions artefact store.
2. Installs cosign via `sigstore/cosign-installer`.
3. Runs `cosign sign-blob --yes --oidc-issuer=... --output-certificate=... --output-signature=...`
   for each tarball. GitHub's OIDC token is automatically requested by cosign
   using the `id-token: write` permission declared in the workflow.
4. Attaches `.pem` and `.sig` files to the GitHub release via `softprops/action-gh-release`.
5. Generates `scripts/release-manifest.signed.json` with the SHA256 digest
   of each signed tarball — this manifest is used by `scripts/install.sh` and
   the Homebrew formula update step for allowlist verification.

## SLSA Level 2 compliance

SLSA L2 requires:

| Requirement                 | Mechanism                                     |
| --------------------------- | --------------------------------------------- |
| Hosted build platform       | GitHub Actions (managed runners)              |
| Scripted build              | `npx turbo build` + `pnpm deploy --prod`      |
| Build provenance exists     | cosign signature + OIDC certificate           |
| Provenance is authenticated | Certificate anchored to OIDC issuer           |
| Provenance is unforgeable   | GH OIDC token is ephemeral; no long-lived key |

SLSA L3 (hermetic builds) is out of scope for this release toolchain and
requires a separate isolated build environment.

## Relationship to SBOM

The SBOM (`docs/explanation/sbom.md`) documents component inventory (what is
in the tarball). This provenance document certifies the build origin (how and
where the tarball was created). The CRA 2027 artefact attestation requirement
is satisfied by both documents together.
