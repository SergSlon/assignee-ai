# Backlog: 108-A-07 — Complete noun-grouped path migration

**Source**: Quinn epic-108-close adversarial sweep — `_archive/reviews/epic-108-close-final-sweep-review.md`
**Effort**: M (~10 hours mechanical + 1 doc-lint regex extension)
**Blocking for**: RR-9 (CHANGELOG v1.0) / RR-10 (external dogfood) / RR-11 (coverage gate cite) — none can credibly close until users see noun-grouped paths everywhere

## Background

Story 108-A-05 migrated the Commander tree + test fixtures + completion bundles
to noun groups (`infra <leaf>`, `admin <leaf>`, `dev <leaf>`). The merged
A-05 commit body claimed "user-facing strings in plan/status/init/setup/drift/
reconcile/discover + error catalogs + core display helpers all updated."

Quinn's epic-108-close adversarial sweep proved that claim was partial:

- **~197 flat-path hits in `docs/`** — `README.md`, `docs/commands.md`,
  `docs/tutorials/getting-started.md`, all of `docs/how-to/`, `docs/drift-detection.md`,
  `docs/explanation/*`, plus many checkpoint snapshots in
  `packages/core/src/test-fixtures/`
- **~95 user-facing source-code strings** still emit flat paths — notably
  `packages/core/src/utils/error-messages/catalog-config.ts` and
  `apps/cli/src/commands/setup/summary.ts:34` (the LAST line `assignee dev setup`
  prints to a fresh user)
- **`apps/cli/src/commands/discover/discover-data.ts:191`** (fixed in the
  epic-close hotfix `<commit-SHA>`) emitted `assignee ${cmd} --help` instead
  of `assignee ${group} ${cmd} --help` — concrete user-visible runtime breakage

## Scope

Complete the flat → noun-grouped migration across:

1. **All `docs/`** — README + tutorials + how-to + explanation + reference. Every
   `assignee plan` / `assignee apply` / etc. → `assignee infra plan` / etc.
2. **Source-code user-facing strings** — error catalogs, hint messages, banner
   text, setup-summary lines.
3. **Checkpoint snapshots** in `packages/core/src/test-fixtures/checkpoints/`
   (these are reference fixtures; their inline `assignee plan` references
   need updating too).
4. **`assignee.ai/_archive/`** content (selective — historical artifacts can
   stay; current-state docs should be migrated).
5. **`_bmad-output/`** active docs (current-iteration story files, sprint-status
   description fields). Closed/archived stories may stay as-is.

## Drift-guard addition

After migration, extend `apps/cli/scripts/doc-lint.mjs` with a regex check
that fails the lint on any new occurrence of the flat-path pattern in `docs/`,
`README.md`, or user-facing source-code strings:

```
const FLAT_PATH_PATTERN = /\bassignee (plan|apply|destroy|drift|reconcile|optimize|restore-provisions|status|list|doctor|describe|audit-verify|init|setup|update|completions|discover|version)\b/g;
// Walk docs/**, README.md, apps/cli/src/**/(utils|commands)/**/*.ts
// (NOT test files — runCli([…]) takes leaf names as args)
// Fail with file:line for any hit.
```

The drift-guard is the long-term protection against regression. Without it,
future stories will introduce new flat-path strings and we'll be back where
we started.

## Acceptance criteria

1. `grep -rE "\bassignee (plan|apply|destroy|drift|…)" docs/ README.md` returns 0 hits.
2. Same grep against `apps/cli/src/utils/error-messages/`, `apps/cli/src/commands/*/summary.ts`,
   `apps/cli/src/utils/first-run.ts`, banner files: 0 hits.
3. `pnpm doc-lint` with the new regex passes.
4. `apps/cli/src/commands/discover/discover-data.ts` command items emit grouped paths (verified by epic-close hotfix).
5. CHANGELOG entry: `cli(docs+strings): complete noun-grouped path migration across docs + user-facing strings (Story 108-A-07)`.
6. Reviewer ACCEPT evidence per BAN.

## Sequencing

- **Depends on**: Epic 108 close-out final state (HEAD).
- **Unblocks**: RR-9 v1.0 CHANGELOG entry can credibly state "API surface frozen and user-facing copy aligned"; RR-10 external dogfood can be commissioned without misleading on-screen examples; RR-11 coverage gate cite stands without caveat.

## Quinn's full finding inventory (round 1 of epic-108-close sweep)

See `_archive/reviews/epic-108-close-final-sweep-review.md` for the verbatim
8-finding table (2 BLOCKER / 1 HIGH / 2 MEDIUM / 3 LOW). This backlog story
captures findings #1–#8 except F-05 (CHANGELOG B-04 duplicate — Paige fixes
in the v1.0 close-out) and F-06 (safety-ref pre-push guard — landed in
epic-close hotfix).

## Closure (2026-05-25)

Backlog story CLOSED. Pre-dispatch grep on 2026-05-25 showed all 30
remaining `\bassignee (plan|apply|...)\b` hits are inside `apps/cli/src/**/*.test.ts`
files — JSDoc comments, `describe()` block titles, code comments — which
the backlog explicitly excludes (test files use `runCli([leaf, ...])`
not user-facing flat-path strings). The rewrite work the backlog
described had already landed across earlier 108-A-\* stories.

What remained — and lands in this commit — is the **drift-guard regex**
in `apps/cli/scripts/doc-lint.mjs` that fails the lint on any future
flat-path string in docs / README / non-test source. This is the
long-term protection the backlog called for. The guard was verified
at a clean baseline: `pnpm doc-lint` returned zero flat-path errors
on HEAD before the commit landed.

Unit tests for the guard's `checkFileForFlatPaths()` function were added
to `apps/cli/src/__tests__/doc-lint.test.ts` (13 new assertions across
two describe blocks: FLAT_PATH_PATTERN regex + checkFileForFlatPaths).

**Closing commit**: `41d7d862` (Quinn ACCEPT — see `_archive/reviews/0b561a73-review.md`; pre-amend SHA was `0b561a73`).
**Acceptance criteria**: all 6 from the original story — met.

- AC1 (`grep docs/ README.md` = 0 hits): confirmed by `pnpm doc-lint` clean run.
- AC2 (source error-messages / commands / first-run = 0 hits): confirmed by `pnpm doc-lint` clean run.
- AC3 (`pnpm doc-lint` passes with new regex): PASS — zero hits on HEAD.
- AC4 (discover-data.ts emits grouped paths): pre-existing — verified by epic-close hotfix.
- AC5 (CHANGELOG entry): added under `## [Unreleased] → ### Added`.
- AC6 (Reviewer ACCEPT): qa (Quinn) — see `_archive/reviews/0b561a73-review.md`.
