# SPDX Software Bill of Materials (SBOM)

## What is the SBOM?

The Assignee.ai release pipeline generates a Software Bill of Materials (SBOM)
in **SPDX 2.3 JSON** format for every published release. The SBOM is an
exhaustive inventory of every open-source package that ships inside the
Assignee.ai CLI tarball, including their versions, licences, and dependency
relationships.

The SBOM is attached to each GitHub release as
`assignee-<version>-sbom.spdx.json`.

## Why does it exist?

The SBOM satisfies requirements from:

- **EU Cyber Resilience Act (CRA) 2027** — Annex I, Part II, § 1(b): products
  with digital elements must supply a machine-readable SBOM in a commonly
  used format.
- **NIS2 Directive** — Article 21(2)(g): essential-entity supply-chain risk
  management requires component transparency.
- **US Executive Order 14028** (NTIA minimum elements) — mandates SBOM for
  software used in federal procurement pipelines.

## How is it generated?

The `generate-sbom` job in `.github/workflows/release.yml.disabled` uses
[`@anchore/sbom-action`](https://github.com/anchore/sbom-action) to scan the
production `node_modules` tree produced by `pnpm deploy --prod` and emit an
SPDX 2.3 JSON document.

A validation step immediately follows, running `spdx-tools validate` to assert
the document is spec-compliant before it is attached to the GitHub release.

The SBOM is generated AFTER `smoke-test` passes (i.e., only when the tarball
is known good) and BEFORE the `generate-provenance` step attaches cosign
signatures.

## How to verify the SBOM

1. Download the SBOM from the GitHub release page:

   ```sh
   curl -LO https://github.com/assignee-ai/assignee/releases/download/v<VERSION>/assignee-v<VERSION>-sbom.spdx.json
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

The SBOM documents _what_ is in the tarball. The SLSA provenance attestation
(see [`supply-chain-provenance.md`](supply-chain-provenance.md)) documents
_how_ the tarball was built and by whom. Together they satisfy the full
CRA 2027 artefact attestation requirement.
