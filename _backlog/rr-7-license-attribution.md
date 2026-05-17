# Backlog: RR-7 LICENSE + 3rd-party attribution audit

**Source**: Epic 108-A RELEASE_CHECKLIST.md RR-7
**Effort**: S
**Blocking for**: `pnpm publish` (v1.0 release)

## Scope

1. Verify `LICENSE` file exists at repo root.
2. Run `pnpm licenses list --json` and review the output.
3. Identify any GPL / AGPL / network-copyleft deps and flag for review.
4. Generate `THIRD-PARTY-NOTICES.md` (or update if exists).
5. User signs off on a separate sign-off doc in `_archive/dogfood-sessions/`.

## Acceptance

- LICENSE file present at repo root (MIT or similar permissive).
- THIRD-PARTY-NOTICES.md updated with current dep tree.
- User sign-off recorded.
- RR-7 `[x]` in RELEASE_CHECKLIST.md with citation.
