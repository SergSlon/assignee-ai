# Backlog: RR-8 npm provenance / signed release artifacts

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
