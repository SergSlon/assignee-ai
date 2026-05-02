# Release Process

<!-- W9-01 (P017 partial -> L1-F14 + L2-F02 + L6-F12) -->

This document describes the Assignee.ai CLI release flow, the DRY-RUN
semantics of `.github/workflows/release.yml`, and how the acquirer enables
full publishing post-go-decision.

## Overview

The release workflow (`release.yml`) is triggered manually via
`workflow_dispatch` — **not** on tag push. Every publish-side step (npm
publish, GitHub release creation, Homebrew tap update) is gated behind an
explicit environment variable. By default, the workflow runs in DRY-RUN mode:
build, test, SBOM generation, provenance signing, and release-notes generation
all execute, but nothing is published.

This design satisfies the `feedback_no_public_artifacts` invariant: the
pipeline is complete and tested before the acquirer's go-decision.

## Environment variable gates

| Variable                   | Default    | Effect when set to `1`                                              |
| -------------------------- | ---------- | ------------------------------------------------------------------- |
| `ASSIGNEE_RELEASE_PUBLISH` | `` (empty) | Enables npm publish, GitHub release, SBOM attach, provenance attach |
| `ASSIGNEE_TAP_PUBLISH`     | `` (empty) | Additionally enables Homebrew tap formula push                      |

Both variables are read from GitHub Actions **vars** (repository variables)
first, then **secrets**, then default to empty string (DRY-RUN).

Set them in: **Settings → Secrets and variables → Actions → Variables** (or
**Secrets** for sensitive values).

## Step-by-step: DRY-RUN (default)

A DRY-RUN verifies the full pipeline without publishing anything.

1. Go to the repository **Actions** tab.
2. Select **Release** workflow.
3. Click **Run workflow**.
4. Fill in:
   - `confirm`: leave as `DRY_RUN` (or type anything other than `YES_PUBLISH`)
   - `tag`: a tag that already exists (e.g. `v0.1.0`)
5. Click **Run workflow**.

What runs:

- `build` — ubuntu build + test (green gate)
- `cross-platform-build` — macOS + Windows + ubuntu matrix
- `publish-dry-run` — `npm pack --dry-run` per package (metadata audit)
- `generate-release-notes` — strips BMAD IDs, emits external-facing notes
- `generate-sbom` — SPDX 2.3 SBOM generation + validation

What is SKIPPED:

- `publish-npm` — npm publish
- `package-binaries` — tarball creation
- `github-release` — GitHub release creation
- `smoke-test` — tarball smoke test
- `generate-provenance` — cosign signing + manifest update
- `update-homebrew` — tap formula push

## Step-by-step: full publish (post-go-decision)

1. **Pre-requisites** (one-time setup):
   - Remove `"private": true` from every `package.json` that should ship.
   - Set `ASSIGNEE_RELEASE_PUBLISH=1` in GitHub repository variables.
   - Set `ASSIGNEE_TAP_PUBLISH=1` in GitHub repository variables (if tap push is wanted).
   - Ensure the `HOMEBREW_TAP_TOKEN` secret is set (PAT with write access to
     the `SergSlon/homebrew-assignee` tap repo).
   - Create and push the release tag: `git tag v0.1.0 && git push origin v0.1.0`

2. Go to **Actions → Release → Run workflow**.
3. Fill in:
   - `confirm`: type `YES_PUBLISH` (exact string)
   - `tag`: the tag you just pushed (e.g. `v0.1.0`)
4. Click **Run workflow**.

All jobs run in sequence:

```
build
  cross-platform-build
    publish-dry-run
      publish-npm          [ASSIGNEE_RELEASE_PUBLISH=1]
      package-binaries     [ASSIGNEE_RELEASE_PUBLISH=1]
    generate-release-notes
    generate-sbom
      github-release       [ASSIGNEE_RELEASE_PUBLISH=1]
        smoke-test         [ASSIGNEE_RELEASE_PUBLISH=1]
          generate-provenance [ASSIGNEE_RELEASE_PUBLISH=1]
            update-homebrew [ASSIGNEE_RELEASE_PUBLISH=1 + ASSIGNEE_TAP_PUBLISH=1]
```

## Release notes

`scripts/generate-release-notes.ts` reads `git log --oneline` between the
previous tag and the release tag, strips BMAD-internal ID patterns (Epic-N,
W9-01, P017, L1-F14, story N, etc.), groups commits by Keep-a-Changelog
category (Added / Changed / Fixed / Deprecated / Removed / Security), and
emits external-facing markdown to `release-notes.md`.

The `github-release` step uses `body_path: release-notes.md` so the GitHub
release body is the generated external notes — not the raw git log.

To preview release notes locally:

```sh
# From the previous tag to HEAD
npx tsx scripts/generate-release-notes.ts --from v0.1.0 --to HEAD

# Or for a specific range
npx tsx scripts/generate-release-notes.ts --from v0.1.0 --to v0.2.0
```

## Supply-chain verification

After a full publish, the release artefacts can be verified:

```sh
# Verify SLSA provenance
cosign verify-blob \
  --certificate "${TARBALL}.pem" \
  --signature "${TARBALL}.sig" \
  --certificate-identity "https://github.com/SergSlon/assignee-ai/.github/workflows/release.yml@refs/heads/main" \
  --certificate-oidc-issuer "https://token.actions.githubusercontent.com" \
  "${TARBALL}"
```

See `docs/explanation/supply-chain-provenance.md` for the full guide.

## Homebrew tap

The `update-homebrew` job renders `homebrew/assignee.rb` (a template with
`$VERSION` and `$SHA_*` placeholders) via `envsubst` and pushes the rendered
formula to the `SergSlon/homebrew-assignee` tap repository. This is gated
behind `ASSIGNEE_TAP_PUBLISH=1` in addition to `ASSIGNEE_RELEASE_PUBLISH=1`.

See `docs/how-to/install-via-homebrew.md` for the installation guide.

## Release Rollback

<!-- W24a-S2 (PR-002) -->

When a bad release ships, follow this procedure to deprecate the npm package,
hide the GitHub release, regenerate the manifest, and revert the Homebrew
formula. For automated assistance use `scripts/rollback-release.sh`.

### Prerequisites

- `npm` CLI authenticated as the `assignee-ai` npm org member.
- `gh` CLI authenticated with write access to `SergSlon/assignee-ai`.
- `git` remote `origin` pointing to `SergSlon/assignee-ai`.
- (If tap revert needed) PAT with write access to the
  `assignee-ai/homebrew-assignee` tap repo set as `HOMEBREW_TAP_TOKEN`.

### Step 1 — Deprecate on npm

Mark the bad version so `npm install` warns all future installers. This does
**not** unpublish — it just sets a deprecation notice.

```sh
npm deprecate assignee@<bad-version> "Critical bug — do not install. Use <last-good-version> instead."
```

Re-verify: `npm info assignee@<bad-version> deprecated`

### Step 2 — Hide the GitHub release

Marking the release as draft removes it from the "latest" pointer and from the
public releases page. This is reversible and preferred over deletion.

```sh
# Mark as draft (reversible — keeps assets intact)
gh release edit <tag> --draft --repo SergSlon/assignee-ai

# If assets must be removed (e.g., binary contained a security vulnerability):
gh release delete-asset <tag> <asset-filename> --repo SergSlon/assignee-ai
```

To fully delete a release and its tag (use only for accidental test releases):

```sh
gh release delete <tag> --yes --repo SergSlon/assignee-ai
git push origin --delete <tag>
```

### Step 3 — Regenerate the release manifest

The signed manifest at `scripts/release-manifest.signed.json` drives the
installer allowlist. After a rollback the bad version entry must be removed and
`minimum_version` bumped to the last-good version so existing installs can
self-update past the bad release.

```sh
# Edit scripts/release-manifest.signed.json:
#   1. Remove the entry for <bad-version> from "entries"
#   2. Set "minimum_version" to <last-good-version>
#   3. Increment "generated_at" to current ISO timestamp

# Commit + push directly to main so install.sh fetches the patched manifest:
git add scripts/release-manifest.signed.json
git commit -m "rollback: remove <bad-version> from release manifest"
git push origin main

# Alternatively, re-trigger the generate-provenance workflow on the patched tag
# to rebuild and re-sign the manifest automatically.
```

### Step 4 — Revert the Homebrew formula

The tap formula must point back to the last-good release SHA. Open a PR
against `assignee-ai/homebrew-assignee`:

```sh
# Clone (or pull) the tap repo
git clone https://github.com/assignee-ai/homebrew-assignee.git
cd homebrew-assignee

# Edit Formula/assignee.rb:
#   - url: change to the <last-good-version> tarball URL
#   - sha256: change to the <last-good-version> SHA256
#   - version: change to <last-good-version>

git checkout -b rollback/<bad-version>
git add Formula/assignee.rb
git commit -m "rollback: revert formula to <last-good-version>"
git push origin rollback/<bad-version>
gh pr create --title "rollback: revert to <last-good-version>" \
  --body "Bad release <bad-version> rolled back. Formula reverted." \
  --repo assignee-ai/homebrew-assignee
```

### Step 5 — Announce in CHANGELOG

If the release was public, add an entry under `[Unreleased]` (or a new
`[<next-patch>]` section) describing the rollback:

```md
### Security / Rollback

- v<bad-version> deprecated and removed from install path. Upgrade to v<last-good-version>.
```

Push the CHANGELOG update to `main`.

### Automation helper

`scripts/rollback-release.sh` automates Steps 1–4 with dry-run support:

```sh
# Dry-run (prints all commands, executes nothing):
ROLLBACK_DRY_RUN=1 BAD_VERSION=v0.2.1 LAST_GOOD_VERSION=v0.2.0 \
  ./scripts/rollback-release.sh

# Live execution (requires authenticated npm + gh CLI):
BAD_VERSION=v0.2.1 LAST_GOOD_VERSION=v0.2.0 ROLLBACK_REASON="critical data-loss bug" \
  ./scripts/rollback-release.sh
```

See `scripts/rollback-release.sh --help` for the full option reference.

---

## Troubleshooting

### Workflow does not appear in the Actions tab

The workflow is triggered only by `workflow_dispatch`. It will appear in the
Actions tab after the first manual trigger.

### `publish-npm` or `github-release` skipped in DRY-RUN

Expected behaviour. These jobs have `if: env.ASSIGNEE_RELEASE_PUBLISH == '1'`.
Set the repository variable to `1` to enable them.

### `update-homebrew` skipped even with ASSIGNEE_RELEASE_PUBLISH=1

Also requires `ASSIGNEE_TAP_PUBLISH=1`. Check both repository variables.

### SBOM validation fails

`spdx-tools validate` is strict about SPDX 2.3 schema. Common causes:

- Missing `SPDXID` on a package node
- Invalid SPDX expression in `licenseConcluded`

File a bug with the `spdx-tools` npm wrapper maintainers if the SBOM is
generated by `anchore/sbom-action` and fails validation.
