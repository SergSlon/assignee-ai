# Supply-Chain Provenance (cosign blob signature + OIDC certificate)

## Overview

Every Assignee.ai release is cryptographically signed using
[cosign](https://github.com/sigstore/cosign) (`cosign sign-blob`) via GitHub's
OIDC identity provider. The resulting detached signature (`.sig`) and
OIDC-anchored certificate (`.pem`) tie each release tarball to the exact
workflow run that produced it.

> **Note on SLSA level:** the current mechanism is a cosign **blob signature**,
> not a full SLSA Level 2 build-provenance attestation (which would require
> `cosign attest-blob` / `slsa-github-generator`). Full SLSA L2 attestation is
> a planned future upgrade. The blob-signature + OIDC-certificate chain
> satisfies the signing mandate from **US Executive Order 14028** and provides
> strong supply-chain integrity without long-lived keys.

The signing certificate is anchored to the GitHub Actions workflow identity —
no long-lived signing keys are used. Verification uses `cosign verify-blob`
and requires only:

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

The `generate-provenance` job in `.github/workflows/release.yml`:

1. Downloads all four platform tarballs from the GitHub Actions artefact store.
2. Installs cosign via `sigstore/cosign-installer`.
3. Runs `cosign sign-blob --yes --oidc-issuer=... --output-certificate=... --output-signature=...`
   for each tarball. GitHub's OIDC token is automatically requested by cosign
   using the `id-token: write` permission declared in the workflow.
4. Attaches `.pem` and `.sig` files to the GitHub release via `softprops/action-gh-release`.
5. Generates `scripts/release-manifest.signed.json` with the SHA256 digest
   of each signed tarball — this manifest is used by `scripts/install.sh` and
   the Homebrew formula update step for allowlist verification.

## Supply-chain integrity posture

The current signing mechanism provides strong blob-level integrity without
long-lived keys. The table below shows how each SLSA L2 requirement maps to
the current implementation:

| Requirement                  | Status   | Mechanism                                                               |
| ---------------------------- | -------- | ----------------------------------------------------------------------- |
| Hosted build platform        | ✓ met    | GitHub Actions (managed runners)                                        |
| Scripted build               | ✓ met    | `npx turbo build` + `pnpm deploy --prod`                                |
| Build artifact signed        | ✓ met    | `cosign sign-blob` — detached `.sig` + `.pem`                           |
| Signature authenticated      | ✓ met    | Certificate anchored to OIDC issuer                                     |
| Signature unforgeable        | ✓ met    | GH OIDC token is ephemeral; no long-lived key                           |
| Build provenance attestation | ✗ future | Requires `cosign attest-blob` / slsa-github-generator (planned upgrade) |

SLSA L2 **proper** (with machine-readable provenance attestation) and SLSA L3
(hermetic builds) are planned future upgrades and are out of scope for the
current release toolchain.

## Relationship to SBOM

The SBOM (`docs/explanation/sbom.md`) documents component inventory (what is
in the tarball). This provenance document certifies the build origin (how and
where the tarball was created). The CRA 2027 artefact attestation requirement
is satisfied by both documents together.
