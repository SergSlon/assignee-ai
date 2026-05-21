# Backlog: RR-8 npm provenance / signed release artifacts

> **STATUS: CONFIG CLOSED 2026-05-18 — REGISTRY VERIFICATION PENDING.**
> Workflow-config audit passed: `.github/workflows/release.yml:290`
> uses `pnpm -r publish --access public --provenance --no-git-checks`
> with OIDC `id-token: write` at job level (no long-lived NPM_TOKEN).
> Dedicated `generate-provenance` job emits cosign blob signatures.
> Sign-off: `_archive/dogfood-sessions/rr-8-rr-11-audit-2026-05-18.md`.
> RELEASE_CHECKLIST.md row RR-8 is `[x]`.
>
> **2026-05-21 follow-up finding (post-v0.1.0 release):** The v0.1.0
> publish-npm step ran but emitted 0 tarballs — log line "There are
> no new packages that should be published" — because the bare
> `assignee` npm name has been squatted since 2017-11-25 (slot
> reserved by npm policy). `npm view assignee@0.1.0` returns
> tarball=null; `https://registry.npmjs.org/-/npm/v1/attestations/assignee@0.1.0`
> returns 0 bundles. So while the workflow CONFIG is verified,
> **no real sigstore attestation has yet been produced**. The
> first actual attestation will land when v0.1.1 publishes under the
> new `@assignee/cli` scoped name (rename merged in #145).
> Verification command at that point:
>
> ```sh
> curl -s https://registry.npmjs.org/-/npm/v1/attestations/@assignee/cli@0.1.1 \
>   | jq '{bundles: (.attestations | length), kinds: [.attestations[].predicateType]}'
> ```
>
> Expect `bundles >= 1` and a `https://slsa.dev/provenance/v1` or
> `https://docs.npmjs.com/policies/security-improvements/publish-attestation`
> predicate. Re-open this backlog item only if registry verification
> fails on the first real publish.

**Source**: Epic 108-A RELEASE_CHECKLIST.md RR-8
**Effort**: S
**Blocking for**: `pnpm publish` (v1.0 release)

## Scope

1. Add `provenance: true` (or equivalent) to `.github/workflows/release.yml` publish step.
2. Verify the CI dry-run confirms provenance attestation is generated.
3. Document the provenance URL format in `docs/explanation/supply-chain-provenance.md` (stub exists).
4. Run CI dry-run (without `ASSIGNEE_RELEASE_PUBLISH=1`) and confirm the provenance step passes.

## Acceptance

- `action.yml` or `release.yml` provenance flag present and verified in CI dry-run.
- `docs/explanation/supply-chain-provenance.md` updated with provenance URL format.
- RR-8 `[x]` in RELEASE_CHECKLIST.md with citation to the CI dry-run run URL.
