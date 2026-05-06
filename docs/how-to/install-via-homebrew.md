# Install Assignee.ai via Homebrew

> **The Homebrew tap has not been published — this install path is currently
> unreachable.** `brew tap SergSlon/assignee-ai` resolves to a non-existent
> repository today, and no public release tarballs exist on GitHub.
> Assignee.ai is a course-submission project; workspace packages are
> `"private": true`. Until a public release ships, install from source.

## Design intent (planned Homebrew flow)

The release pipeline (`.github/workflows/release.yml`) is wired to render a
Homebrew formula (`homebrew/assignee.rb`) and push it to a tap repository
once two gates flip:

- `ASSIGNEE_RELEASE_PUBLISH=1` — enables npm publish, GitHub Release,
  SBOM/provenance attach, and the Homebrew formula render step.
- `ASSIGNEE_TAP_PUBLISH=1` — additionally enables the formula push to
  `SergSlon/homebrew-assignee` (tap repo not yet created).

When both gates flip, end users would run:

```sh
brew tap SergSlon/assignee-ai
brew install assignee
assignee --version
```

The formula's SHA256 would be cross-checked against
`scripts/release-manifest.signed.json`, and the tarball would be
independently verifiable with `cosign` against the GitHub Actions OIDC
issuer. See
[`../explanation/supply-chain-provenance.md`](../explanation/supply-chain-provenance.md)
for the full verification design.

## Live install path — build from source

```sh
git clone https://github.com/SergSlon/assignee-ai.git
cd assignee-ai
pnpm install
pnpm build

# Run the CLI directly:
node apps/cli/dist/index.js --version

# Or alias it in your shell:
alias assignee="node $(pwd)/apps/cli/dist/index.js"
```

See [`quickstart.md`](quickstart.md) for the full setup recipe.
