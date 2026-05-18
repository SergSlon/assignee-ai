# RR-1 — Publish flip + dispatch (full autonomous)

**Date**: 2026-05-18
**Story**: 108-A-06 RELEASE_CHECKLIST.md → RR-1 closure
**Operator**: coordinator (autonomous run; user explicitly waived
approval gate)
**Status**: COMPLETED — `apps/cli/package.json` flipped + `publishConfig`
set; `ASSIGNEE_RELEASE_PUBLISH` variable set; release workflow
dispatched.

---

## Authorization

User's verbatim instructions this session, in escalating order:

1. "choose most efficient way but don't add claude attribuions" —
   standing session authorization for SKIP-token quotes.
2. "Most important and valuable, then rest non-stop, without my
   cinfirmayion" — drive autonomously through remaining publish-gate
   items.
3. "No need for my approval!!! You should act independently!" —
   explicit waiver of the `feedback_no_public_artifacts` memory's
   approval requirement.

The standing memory `feedback_no_public_artifacts` previously required
explicit user authorization before any public artifact ships. The
user has provided that authorization with instruction #3 above. The
coordinator proceeds.

## In-repo changes

- `apps/cli/package.json`: `"private": true` → `"private": false`.
- `apps/cli/package.json`: adds top-level
  `"publishConfig": { "access": "public", "provenance": true }`.

Other workspace packages remain `"private": true` (`@assignee/core`,
`@assignee/best-practices`, `@assignee/mcp-server`,
`@assignee/eslint-config`, `@assignee/tsconfig`). Only the
top-level `assignee` CLI is exposed for v1.0. The MCP server can
be flipped in a follow-on commit when it's ready for public use;
it depends on `@assignee/core` which is also currently private,
so flipping just mcp-server without a story-level decision on the
internal-package boundary is out of scope here.

## Out-of-repo actions performed

Per the user's "act independently" directive:

1. **`gh variable set ASSIGNEE_RELEASE_PUBLISH 1`** — repo variable
   flipped. The release workflow's publish-side steps are now
   un-gated.
2. **`gh workflow run release.yml --ref main`** — release workflow
   dispatched.

The dispatched workflow will:

- Build all packages.
- Generate SBOM (W7-08 step).
- Generate SLSA build provenance via OIDC.
- Run `npm pack --dry-run` per publishable package (metadata regression check).
- Attempt `pnpm -r publish --access public --provenance --no-git-checks`.

**Important external dependency**: npm registry trust policy for the
`assignee` package name must be configured to accept publishes from
the `SergSlon/assignee-ai` GitHub repository via OIDC. If this is the
first publish attempt and the trust policy isn't set up on npm's side,
the publish step will fail with a permission error from the registry.
That is NOT a regression in this repo; it's a one-time external setup
the user needs to perform on npmjs.com:

```
# On npmjs.com → package settings → "Publishing access":
# Add a trusted publisher → GitHub → SergSlon/assignee-ai →
# workflow file: release.yml → environment: (empty)
```

If the workflow fails at npm publish, the build + provenance + SBOM
artefacts are still produced; the failure is recoverable by
completing the npm trust setup and re-running the workflow without
any new commit needed.

## Verification commands

```bash
# In-repo flip verified
grep -A 4 "\"private\":" apps/cli/package.json | head -6

# Workflow dispatched
gh run list --workflow=release.yml --limit 1

# After workflow completes (success):
npm view assignee@0.1.0 versions

# After workflow completes (failure):
gh run view <run-id> --log-failed
```

## RELEASE_CHECKLIST.md status after merge

| #                 | Item                                   | Status                                                                          |
| ----------------- | -------------------------------------- | ------------------------------------------------------------------------------- |
| RR-1              | `private: false` + `publishConfig` set | ✅ THIS COMMIT                                                                  |
| RR-2..9 / 11 / 12 | Closed across Epic 108 + small-wins    | ✅                                                                              |
| RR-10             | External user dogfood session          | ⏳ Outreach prep in parallel PR; cannot autonomously recruit an external tester |

11 of 12 BLOCKING items checked after this PR + the RR-10 outreach-prep
PR. RR-10 by definition cannot be coordinator-closed; it requires
an actual external person to run `assignee infra plan` end-to-end
and sign off.

## Verification of the publish workflow's behaviour

The release workflow's relevant steps from `.github/workflows/release.yml`:

- Line 11: `Publish-side steps ... are gated behind ASSIGNEE_RELEASE_PUBLISH=1.`
- Line 45-47: OIDC `id-token: write` permission for the `publish-npm` job.
- Line 71-77: dedicated `generate-provenance` job emits SLSA attestation.
- Line 278: `run: pnpm -r publish --access public --provenance --no-git-checks`.
- Line 8-9: build/SBOM/provenance steps run unconditionally; only the
  actual `npm publish` is gated by the repo variable.

This commit + the dispatch operation together close RR-1.
