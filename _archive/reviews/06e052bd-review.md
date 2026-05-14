# Reviewer: ACCEPT — qa (Quinn) — EPIC-106-4

**Commit (pre-amend)**: `06e052bd` — fix(display): filter underscore-prefix internal fields + EFS advisor polish
**Base**: `ddf141ef` (origin/main pre-EPIC-106-3)
**Story**: `_bmad-output/implementation-artifacts/epic-106-4-vpc-default-hint-display-leak.md`

## Gate-criteria verification

1. **Closure 1 — `_X` keys filtered** — `format-desired-state.ts:36-38` adds a 1-line guard `if (key.startsWith("_")) continue;` at the top of the per-entry iteration loop, BEFORE friendly-label resolution and sensitive-field masking. Generic filter; not VpcDefaultHint-specific. ✓

2. **Closure 2 — EFS-advisor wording per spec line 25** — `efs-default-vpc-hint.ts:30-31` emits `${WARNING} Detected 'vpc-default' but EFS currently always creates a private VPC. To use the default VPC, see roadmap item deferred-existing-resource-discovery-extractor or run with --set VpcId=<id>.` — byte-for-byte match to spec wording with the WARNING icon prefix per `eventbridge-no-target-hint.ts` precedent. ✓

3. **Closure 3 — generic filter coverage** — `display-plan.test.ts` adds 3 tests under EPIC-106-4 description: `_VpcDefaultHint` (Variation A), `_resourceId` + `BucketName` co-existence (Variation B), and `_provisionRecord` (Variation B extended). Each test asserts the underscore key/label AND its value are absent from rendered output, AND that a non-underscore property still renders. ✓

4. **Closure 4 — 4 variations covered** — Variation A (`_VpcDefaultHint` filtered) ✓, B (`_resourceId` filtered, generic) ✓ + extended (`_provisionRecord`) ✓, C (advisor wording when `_VpcDefaultHint=default-vpc` and EFS) covered in efs-default-vpc-hint.test.ts Variation E ✓, D (no advisor for non-EFS) covered in CP-3's pre-existing Variation F (3 sub-tests for S3/Lambda/EC2_VPC at lines 69-88 — unchanged by this commit, still pass). ✓

## Test-weakening check (extra-rigor on Variation E adaptation)

The pre-existing Variation E in efs-default-vpc-hint.test.ts asserted `result[0]).toContain("SubnetIds")`. The new wording for the default-vpc branch (non-existing-vpc case) no longer contains "SubnetIds" — it now only appears in the `isExistingVpc` suffix path. The dev REPLACED the `SubnetIds` assertion with **two stronger spec-required substring assertions**:

- `"EFS currently always creates a private VPC"` — anchors the new spec wording (was not asserted before)
- `"deferred-existing-resource-discovery-extractor"` — anchors the roadmap reference (was not asserted before)
- `"--set VpcId=<id>"` — kept the escape-hatch assertion (with `<id>` placeholder per new wording)

This is a **legitimate adaptation to the new spec wording**, not a weakening. Variation C (existing-vpc-id branch) at lines 33-41 still asserts `--set VpcId=` separately; the `SubnetIds=...` suffix in the existing-vpc path is functionally tested via that branch even though not as a substring assertion. Net: 3 new substring assertions added, 1 removed (because the asserted token now belongs to a different branch). **Strengthening, not weakening.** ✓

## CP-3 nit closure

This story closes the informational nit flagged in CP-3's review ("\_VpcDefaultHint single-underscore key vs codebase \_\_doubleUnderscore convention — functionally safe; applyPresetFields ignores unknown keys"). The dogfood made the symptom user-visible (`_Vpc Default Hint   default-vpc` row repeated across 10 EFS resources), confirming that "functionally safe" was insufficient for UX.

The dev's choice to filter on `startsWith("_")` (single underscore) is **correct and forward-compatible**:

- Catches BOTH `_VpcDefaultHint` (single) AND `__assertedCidr`/`__assertedRegion`/`__noVpc` (double) prefixes.
- Both conventions are for internal fields; neither should leak to user display.
- Stricter than the existing `mergePresetFields` guard at `intent-parser/index.ts:224` which uses `key.startsWith("__")` — the display path is correctly more conservative than the presetFields propagation path (display has tighter privacy needs).
- Forward-compatible: any future internal field added with `_X` or `__X` prefix is auto-hidden from display.

## Adversarial checks

- **False-positive on legitimate CFN properties?** Grepped `packages/core/src/config` for any string-literal CFN property name starting with `_` — zero matches. AWS CFN convention is PascalCase without leading underscore (`BucketName`, `FileSystemId`, `MasterUserPassword`, etc.). Filter cannot false-positive. ✓
- **Filter placement** — Guard runs BEFORE `resolveFieldLabel(key, resourceType)` and BEFORE the sensitive-field masking branch. Correct: a sensitive field with `_` prefix would still be skipped (extremely unlikely combination, but defensible). ✓
- **mcp-server mirror** — Display rendering is consumed via shared core path (`@assignee/core` exports `formatDesiredState`); no parallel mcp-server implementation. ✓
- **PENDING token** in commit body present and correctly NOT pre-empting review. ✓

## Build + tests

- `pnpm build`: green (FULL TURBO, 4/4 cached).
- Targeted: 48/48 display-plan.test.ts + 10/10 efs-default-vpc-hint.test.ts = 58/58 pass in 3.17s.
- Broader sanity: 1457/1457 across `src/utils` + `src/graph/nodes/advice`. No regression.
- No live AWS, no new deps.

## File-ownership verification

Per story spec, 4 source files + CHANGELOG (matches dev_summary):

- `packages/core/src/utils/display-helpers/format-desired-state.ts` (+3) — single-line `startsWith("_")` guard ✓
- `packages/core/src/graph/nodes/advice/efs-default-vpc-hint.ts` (+3/-3) — advisor wording polished to spec line 25 ✓
- `packages/core/src/graph/nodes/advice/efs-default-vpc-hint.test.ts` (+6/-3) — Variation E adapted; Variation C unchanged ✓
- `packages/core/src/utils/display-plan.test.ts` (+38) — 3 new tests for Variations A + B + B-extended ✓
- `CHANGELOG.md` (+4) — concise `[Unreleased]` entry citing both display filter + advisor polish ✓

## Verdict

ACCEPT — clean MED-S fix that closes both PH5-4-A and my prior CP-3 informational nit. Generic underscore-prefix filter is forward-compatible and cannot false-positive on real CFN properties. Advisor wording matches spec verbatim. Test adaptation is legitimate strengthening, not weakening (3 new substring assertions vs 1 removed-now-belongs-to-different-branch).
