# Release Process

> **The release pipeline runs in DRY-RUN by default and has never been
> flipped to live publish.** Assignee.ai is a course-submission project;
> workspace packages are `"private": true`, no npm or Homebrew artefacts
> exist publicly, and there is nothing to roll back today. The notes
> below describe the as-built pipeline as design intent.

## Design intent (publish-side gates)

`.github/workflows/release.yml` is triggered manually
(`workflow_dispatch`) — never on tag push. Every publish-side step is
gated behind a repository variable. Defaults run a complete dry-run:
build, cross-platform matrix, `npm pack --dry-run`, SBOM generation,
provenance attestation generation, and external-facing release-notes
generation all execute, but **nothing is published**.

| Variable                   | Default | Effect when set to `1`                                              |
| -------------------------- | ------- | ------------------------------------------------------------------- |
| `ASSIGNEE_RELEASE_PUBLISH` | unset   | Enables npm publish, GitHub Release, SBOM attach, provenance attach |
| `ASSIGNEE_TAP_PUBLISH`     | unset   | Additionally enables Homebrew tap formula push                      |

Both variables are read from GitHub Actions repository **vars** first,
then **secrets**, then default to empty string (DRY-RUN). The dry-run
satisfies the no-public-artifacts invariant for the course submission
window — the pipeline is fully tested without ever publishing.

## Live path — build and run from source

The supported install path today is a source build:

```sh
git clone https://github.com/SergSlon/assignee-ai.git
cd assignee-ai
pnpm install
pnpm build
node apps/cli/dist/index.js --version
```

See [`quickstart.md`](quickstart.md) for the full setup recipe and
[`install-via-homebrew.md`](install-via-homebrew.md) for the planned
Homebrew flow.

## After a real release exists

A future maintainer enabling publish would:

1. Provision an npm organisation, set `ASSIGNEE_RELEASE_PUBLISH=1`.
2. Create the `SergSlon/homebrew-assignee` tap repo and set
   `ASSIGNEE_TAP_PUBLISH=1` plus the `HOMEBREW_TAP_TOKEN` secret.
3. Push a release tag (`git tag v0.1.0 && git push origin v0.1.0`).
4. Trigger the **Release** workflow with `confirm: YES_PUBLISH` and the
   release tag.

Rollback design (npm deprecate, GitHub release draft, manifest
regeneration, Homebrew formula revert) is encoded in
`scripts/rollback-release.sh` with `ROLLBACK_DRY_RUN=1` support — that
script is the canonical rollback runbook once a public release exists.
