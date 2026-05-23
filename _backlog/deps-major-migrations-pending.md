# Backlog: pending major-version dependency migrations

**Source**: dependabot weekly cycle 2026-05-22 ai-sdk + dev-deps batch.

Two major-version bumps were closed without merge because they're
breaking-API migrations rather than routine dependency bumps.
Filed here so dependabot's repeated offers don't get treated as
new work each Monday.

---

## zod 3 → 4 (`zod@>=3 -> ^4.4.3`)

**Closed PR**: #143 (2026-05-23).

**Why deferred**: zod 4 changed the `ZodError` API. CI fails on:

```
src/loader.ts:27 — Property 'errors' does not exist on type 'ZodError<unknown>'
src/loader.ts:81 — same
src/schema.ts:47 — Expected 2-3 arguments, but got 1
src/schema.ts:49 — same
```

**Migration work required**:

1. Rename every `.errors` property access on `ZodError` to `.issues`
   (per zod 4 migration guide). Touch points seen so far:
   `packages/best-practices/src/loader.ts:27,28,81,82`.
2. Update `.refine()` / `.transform()` callsites whose signatures
   changed arity in 4.x. Touch points:
   `packages/best-practices/src/schema.ts:47,49`.
3. Run all schema-validation tests to surface any other API drift
   (zod is used throughout config / BP / pricing — broader surface
   than the 2 files CI flagged).
4. Update zod-related test fixtures if the issue shape changed.

**Effort**: M (~3-4h scoped, plus any indirect surface area in
core/pricing/config).

**Sequencing**: zod 4 has no urgent CVE; safe to defer. Pick up
when scheduled migration time is available.

---

## ESLint 9 → 10 (`@eslint/js@>=9 -> ^10.0.1`)

**Closed PR**: #144 (2026-05-23). Previously also closed as PR #122
(2026-05-22) when bundled with vitest 4 in the dev-deps group.
Subsequent fix #139 added `update-types: [minor, patch]` to
dependabot groups so this major comes through as its own reviewable
PR (#144) rather than entangled with safe minors.

**Why deferred**: ESLint 10 moved/removed `FlatESLint`. CI fails on:

```
TypeError: Class extends value undefined is not a constructor or null
  at Object.<anonymous> (.../@typescript-eslint/utils@8.50.0/.../FlatESLint.js:12:49)
```

The `@typescript-eslint/utils@8.50.0` we depend on still references
the removed API.

**Migration work required**:

1. Bump `@typescript-eslint/*` packages to versions that target
   ESLint 10's API (likely `@typescript-eslint/*@9.x` or newer).
2. Audit any custom ESLint rules / configs in
   `packages/eslint-config/` for ESLint 10 removed-API references.
3. Review the ESLint 10 migration guide for other removed APIs.
4. Run `pnpm lint` across all packages to surface drift.

**Effort**: M (~2-3h; smaller than zod because the surface is
narrower — eslint config is a single package).

**Sequencing**: ESLint 9 still receives security patches; defer
safely. Pick up when the migration is scheduled, ideally with
typescript-eslint major upgrade.

---

## Process note

Dependabot's `update-types: [minor, patch]` groups (added in PR #139)
correctly route majors as individual PRs. The expected pattern going
forward:

- Weekly Monday cycle proposes the routine bumps grouped.
- Majors come as separate PRs.
- Coordinator closes failing-major PRs with rationale + adds to this
  backlog file.
- When migration time is allocated, this file becomes the work plan.

No action needed until both migrations are explicitly scheduled.
