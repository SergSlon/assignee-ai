# Reviewer: ACCEPT — qa (Quinn) — 108-B-01-variant-matrix-harness

**Commit (pre-amend)**: `c4379f59` — feat(test): variant-matrix harness scaffold (Story 108-B-01)
**Base**: `7ae465a3` (origin/main)
**Story spec**: `_bmad-output/implementation-artifacts/epic-108-B-01-variant-matrix-harness.md`
**Epic**: 108-B Quality Infrastructure — Wave 0 foundation story

## Scope

- `packages/core/src/__tests__/variant-matrix/` — new directory with 6 files (index.ts, README.md, drift-guard.test.ts, mock-llm-adapter.ts, mock-llm-adapter.test.ts, type-intent-seed.test.ts)
- `packages/core/src/graph/nodes/intent-parser/resolve-intent-for-type.ts` — pure wrapper around `createIntentParserNode`
- `CHANGELOG.md` — Unreleased entry

8 files total, 1360 insertions. Zero `apps/cli/` imports. Build-time package-boundary enforcement (core can't depend on cli).

## Verification (Opus reviewer, single round)

**Scope integrity**: PASS — 8 files exactly per `git show --stat`. No apps/cli/ leak.

**Registry derivation** (the spec's central requirement): PASS with caveat — `enumerateTypes/Patterns/BpRules` iterate live registries (`SUPPORTED_TYPES_ARRAY`, `defaultPatternRegistry.list()`, `loadBestPractices()`); coverage assertions are key-based, not count-based.

- Drift-guard sentinel tests (Axis A, B): inject `test-sentinel::FakeResource` / `test-sentinel-pattern`, assert guard fires. PASS.
- MATRIX is 38 types × 3 shapes = 114 rows in `type-intent-seed.test.ts:104-109`. PASS.
- MockLlmAdapter `_responseCache` interns frozen fixtures for `toBe` identity equality. PASS.
- Unknown-type fallback returns `UNSUPPORTED_SCRIPTED_RESPONSE` singleton. PASS.

**Downstream-consumer doc (AC#6 README)**: PASS — README §"Using resolveIntentForType in new stories" (lines 115-136) shows mock discovery port + MockLlmAdapter + `resolveIntentForType` recipe. Wave-1 dev can copy-paste.

**Build/test independence**: `pnpm build` PASS (4/4 packages, FULL TURBO). `pnpm test` (variant-matrix dir): 184/184 PASS.

**Anti-fabrication**: Deviation #2 (executionStatus assertion) verified — `intent-parser/index.ts:274-306` confirms `buildExtractionSuccessUpdate` returns the spread without `executionStatus`. Dev's read of code is accurate.

## Non-blocking findings (LOW — track for follow-up)

- **F1 LOW** `drift-guard.test.ts:201` — `expect(CLI_COMMANDS.length).toBe(17)` is exact-equality. Per `CLI_COMMANDS` tuple comment (`index.ts:131`) this is intentional ("compile-time signal that a new command was added"), but should normalize to `>= 17` with a comment OR a key-based check via `enumerateCommands()` in a later story.
- **F2 LOW** Axis I has no executable test — only `mock-llm-adapter.ts` comments reference the no-apps/cli invariant. Package-boundary enforcement is implicit (core cannot depend on cli). Optional: add fs-based grep assertion.
- **F3 INFO** Numeric floors `>= 13` patterns / `>= 185` BP rules are regression guards (fail on removal), not drift drivers. Acceptable per "fail on removal" semantics.

## Verdict

ACCEPT — Wave 0 foundation lands; F1/F2 tracked as follow-up.
