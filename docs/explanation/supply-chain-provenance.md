# Supply-Chain Provenance (cosign blob signature + OIDC certificate) — design intent

> **Status for this build.** The provenance workflow is wired in
> `.github/workflows/release.yml`'s `generate-provenance` job, but the
> release pipeline is **dry-run by default** — gated on
> `ASSIGNEE_RELEASE_PUBLISH=1`, which has not been flipped for this
> course-submission build. **No public release has been published**,
> so no signed tarball, certificate, or signature artefact has actually
> been emitted. The verification commands below describe the _design_
> of how a consumer would verify a release if one existed; treat them
> as hypothetical.

## Overview

The release workflow is designed to cryptographically sign every
release using [cosign](https://github.com/sigstore/cosign)
(`cosign sign-blob`) via GitHub's OIDC identity provider. The resulting
detached signature (`.sig`) and OIDC-anchored certificate (`.pem`)
would tie each release tarball to the exact workflow run that produced
it.

> **Note on SLSA level (design intent).** The current mechanism is a
> cosign **blob signature**, not a full SLSA Level 2 build-provenance
> attestation (which would require `cosign attest-blob` /
> `slsa-github-generator`). Full SLSA L2 attestation is design intent
> for any future productisation; the blob-signature + OIDC-certificate
> chain is the current sketch and provides strong supply-chain
> integrity without long-lived keys.

The signing certificate would be anchored to the GitHub Actions
workflow identity — no long-lived signing keys are used. Verification
would use `cosign verify-blob` and require only:

- The tarball (or its digest).
- The workflow identity URL and OIDC issuer (both public).

## Provenance artefacts (when releases run)

Each GitHub release is designed to include, alongside the tarballs:

| File                                       | Description                                               |
| ------------------------------------------ | --------------------------------------------------------- |
| `assignee-<version>-<platform>.tar.gz`     | The release tarball                                       |
| `assignee-<version>-<platform>.tar.gz.pem` | Signing certificate (OIDC-bound)                          |
| `assignee-<version>-<platform>.tar.gz.sig` | cosign signature                                          |
| `assignee-<version>-sbom.spdx.json`        | SPDX SBOM (see `sbom.md`)                                 |
| `scripts/release-manifest.signed.json`     | SHA256 manifest for install.sh + Homebrew (design intent) |

## Verifying a tarball (hypothetical — no published releases yet)

The commands below describe the verification flow once a real release
exists. They will not work today.

### Prerequisites

```sh
# Install cosign (macOS)
brew install cosign

# Install cosign (Linux)
curl -sSLO https://github.com/sigstore/cosign/releases/latest/download/cosign-linux-amd64
chmod +x cosign-linux-amd64
sudo mv cosign-linux-amd64 /usr/local/bin/cosign
```

### Verify a specific release (hypothetical)

```sh
# Hypothetical — no published releases yet
VERSION="v0.1.0"
PLATFORM="darwin-arm64"   # or darwin-x64 / linux-x64 / linux-arm64

TARBALL="assignee-${VERSION}-${PLATFORM}.tar.gz"
CERT="assignee-${VERSION}-${PLATFORM}.tar.gz.pem"
SIG="assignee-${VERSION}-${PLATFORM}.tar.gz.sig"

# Download all three files from the GitHub release
curl -LO "https://github.com/<owner>/<repo>/releases/download/${VERSION}/${TARBALL}"
curl -LO "https://github.com/<owner>/<repo>/releases/download/${VERSION}/${CERT}"
curl -LO "https://github.com/<owner>/<repo>/releases/download/${VERSION}/${SIG}"

# Verify the signature
cosign verify-blob \
  --certificate "${CERT}" \
  --signature "${SIG}" \
  --certificate-identity "https://github.com/<owner>/<repo>/.github/workflows/release.yml@refs/heads/main" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  "${TARBALL}"
```

> **Identity hint.** The `<owner>/<repo>` placeholder above is just
> that — a placeholder. The actual `--certificate-identity` value once
> a release ships will be
> `https://github.com/SergSlon/assignee-ai/.github/workflows/release.yml@refs/heads/main`,
> matching the `# cosign verify-blob` comment block at
> `release.yml:673`. Until then, no certificate has been issued
> against any identity.

A successful verification would print:

```
Verified OK
```

### What is being verified?

The `--certificate-identity` value asserts that the signing certificate
was issued to the exact GitHub Actions workflow file path listed. Any
tarball signed by a different workflow, a different branch, or a
different repository would fail verification.

The `--certificate-oidc-issuer` asserts that GitHub's OIDC provider
issued the certificate (not a third-party token service).

Together these constraints would mean: _this tarball was built by the
official Assignee.ai release workflow, running on GitHub's
infrastructure, from the `main` branch_.

## How provenance is generated (in design — not exercised yet)

The `generate-provenance` job in `.github/workflows/release.yml`:

1. Downloads all four platform tarballs from the GitHub Actions artefact store.
2. Installs cosign via `sigstore/cosign-installer`.
3. Runs `cosign sign-blob --yes --oidc-issuer=... --output-certificate=... --output-signature=...`
   for each tarball. GitHub's OIDC token is automatically requested by cosign
   using the `id-token: write` permission declared in the workflow.
4. Attaches `.pem` and `.sig` files to the GitHub release via `softprops/action-gh-release`.
5. Generates `scripts/release-manifest.signed.json` with the SHA256 digest
   of each signed tarball — this manifest would be used by
   `scripts/install.sh` and the Homebrew formula update step for
   allowlist verification.

> **Dry-run state.** Today this job is fully skipped on dry-run — the
> `generate-provenance` job declares a job-level
> `if: inputs.confirm == 'YES_PUBLISH' && vars.ASSIGNEE_RELEASE_PUBLISH == '1'`
> at `release.yml:681`, so cosign signing has never been exercised
> against a real tarball. Even the `Sign release artefacts` step inside
> the job has not run; no signed `.sig` / `.pem` artefact has ever
> been emitted by this workflow.

## Supply-chain integrity posture (design intent)

The signing mechanism described above would provide strong blob-level
integrity without long-lived keys. The table below shows how each
SLSA L2 requirement would map to the design:

| Requirement                  | Status (design intent) | Mechanism                                             |
| ---------------------------- | ---------------------- | ----------------------------------------------------- |
| Hosted build platform        | designed               | GitHub Actions (managed runners)                      |
| Scripted build               | designed               | `npx turbo build` + `pnpm deploy --prod`              |
| Build artifact signed        | designed               | `cosign sign-blob` — detached `.sig` + `.pem`         |
| Signature authenticated      | designed               | Certificate anchored to OIDC issuer                   |
| Signature unforgeable        | designed               | GH OIDC token is ephemeral; no long-lived key         |
| Build provenance attestation | future work            | Requires `cosign attest-blob` / slsa-github-generator |

SLSA L2 **proper** (with machine-readable provenance attestation) and
SLSA L3 (hermetic builds) would be future productisation work. None of
the rows above describe a feature that has been exercised on a real
public release of this project — they are design intent.

## Relationship to SBOM

The SBOM (`docs/explanation/sbom.md`) documents the component
inventory the release would carry. This provenance document describes
how the build origin would be certified. Both are design intent;
neither has yet run on a published release.
