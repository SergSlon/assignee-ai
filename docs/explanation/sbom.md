# SPDX Software Bill of Materials (SBOM) — design intent

> **Status for this build.** SBOM generation is **wired in
> `.github/workflows/release.yml`** (the `generate-sbom` job) but the
> release workflow is dry-run-by-default — gated by the
> `ASSIGNEE_RELEASE_PUBLISH=1` env var, which has not been flipped for
> this course-submission build. **No public release has been
> published**, so no SBOM artefact has actually been emitted to a
> GitHub release page. The verification commands below describe the
> _design_ of how a consumer would verify an SBOM if a real release
> existed; treat them as hypothetical until that day comes.

## What the SBOM is meant to be

The Assignee.ai release workflow is designed to generate a Software
Bill of Materials in **SPDX 2.3 JSON** format for every published
release. The SBOM is intended to be an exhaustive inventory of every
open-source package that ships inside the CLI tarball, including
versions, licences, and dependency relationships.

When a release is eventually published, the SBOM would be attached to
each GitHub release as `assignee-<version>-sbom.spdx.json`.

## Why the design includes an SBOM

Component transparency is industry-standard practice for any
credential-handling tool. Generating an SBOM from the production
`node_modules` tree at release time is a low-cost, high-clarity way to
make that transparency machine-readable.

## How it is generated (when releases run)

The `generate-sbom` job in `.github/workflows/release.yml` uses
[`@anchore/sbom-action`](https://github.com/anchore/sbom-action) to
scan the workspace tree (`anchore/sbom-action` is invoked with
`path: .`); package-manager metadata (`devDependencies` keys in
`package.json` plus `pnpm-lock.yaml` resolution data) is what
distinguishes prod from dev dependencies in the resulting SPDX
document. Verified at `release.yml:597-602` (action invocation +
`path: .`).

A validation step immediately follows, running `spdx-tools validate`
to assert the document is spec-compliant before it would be attached
to the GitHub release.

The job is sequenced as `cross-platform-build → generate-sbom`
(declared at `release.yml:537`: `generate-sbom: needs: cross-platform-build`),
i.e. the SBOM job runs against the same tarball the cross-platform
matrix produced. The cosign provenance job (`generate-provenance`)
in turn declares `needs: [smoke-test, generate-sbom]` at
`release.yml:680`, so cosign signing only proceeds after both the
tarball smoke-test and the SBOM emission have succeeded.

## How a consumer would verify an SBOM (hypothetical — no published releases yet)

The commands below describe the verification flow once a release has
been published. They will not work today because no release exists.

1. Download the SBOM from the GitHub release page:

   ```sh
   # Hypothetical — no published releases yet
   curl -LO https://github.com/<owner>/<repo>/releases/download/v<VERSION>/assignee-v<VERSION>-sbom.spdx.json
   ```

2. Install spdx-tools:

   ```sh
   npm install -g spdx-tools
   ```

3. Validate:

   ```sh
   spdx-tools validate assignee-v<VERSION>-sbom.spdx.json
   ```

   Exit 0 = valid SPDX 2.3 document.

4. Inspect the package inventory:

   ```sh
   node -e "
     const sbom = JSON.parse(require('fs').readFileSync('assignee-v<VERSION>-sbom.spdx.json', 'utf8'));
     console.log('Packages:', sbom.packages?.length ?? 0);
     for (const p of sbom.packages ?? []) {
       console.log(' ', p.name, p.versionInfo, '—', p.licenseConcluded);
     }
   "
   ```

## SBOM format reference

- **Format**: SPDX 2.3 (JSON encoding)
- **Primary component**: `assignee` CLI (`apps/cli/`)
- **Scope**: all production `node_modules` shipped in the tarball (devDependencies excluded)
- **Relationship types**: `DESCRIBES`, `DEPENDS_ON`, `CONTAINS`
- **NOASSERTION handling**: packages whose licence could not be auto-detected
  appear as `NOASSERTION` — this is an SPDX-compliant placeholder, not an error.
  The full licence texts are in `THIRD-PARTY-NOTICES.md`.

## Relationship to supply-chain provenance

The SBOM documents _what_ would be in a release tarball. The cosign
provenance design (see [`supply-chain-provenance.md`](supply-chain-provenance.md))
documents _how_ a tarball would be built and by whom. Both pieces are
sketched as design intent for future productisation; neither has yet
been exercised on a published release.
