# Reviewer: ACCEPT — Quinn (qa) — EPIC-106-9

Summary: decomposer-scope work byte-identical and well-guarded; strategies-layer drift flagged as follow-up.

# EPIC-106-9 Review — c55568d8

## Verdict

ACCEPT

The decomposer-scoped work delivered exactly what the closure criteria asked
for. Output is byte-identical to pre-refactor; the new helper has its own
unit tests covering pluralisation edges; the snapshot guard correctly
enforces the canonical `/^\/M [a-z ]+$/` shape across all five target
decomposers. Build passes, `pnpm --filter @assignee/core test` runs all 9319
tests green including the 19 new helper tests.

However, the commit body and CHANGELOG both claim "Epic-106 is now fully
closed" — and the live-system cost-label drift the dogfood actually
surfaced (`"$0.0000005000/million publishes (live)"`,
`"~$1.03/million req"`) originates in `packages/core/src/pricing/strategies/*.ts`,
which is OUT OF SCOPE of this story and STILL EMITS those non-canonical
strings. The closure of PH5-X-COST-LABEL at the decomposer layer is real,
but the user-visible bug at the strategies layer is not addressed by this
work. Calling it out so it lands as a follow-up rather than getting lost.

## Closure criteria verified

1. **Output byte-identity**: each per-million `PriceUnit` constant maps
   1:1 to its prior literal.
   - `formatUnitSuffix("req")` → `"/M reqs"` (price-units.ts:24, prev "/M reqs")
   - `formatUnitSuffix("read req")` → `"/M read reqs"` (price-units.ts:25, prev "/M read reqs")
   - `formatUnitSuffix("write req")` → `"/M write reqs"` (price-units.ts:26, prev "/M write reqs")
   - `formatUnitSuffix("msg")` → `"/M msgs"` (price-units.ts:27, prev "/M msgs")
   - `formatUnitSuffix("min")` → `"/M mins"` (price-units.ts:28, prev "/M mins")
   - `formatUnitSuffix("publish")` → `"/M publishes"` (price-units.ts:29, prev "/M publishes")
     [pluralise() correctly applies "sh" → "shes" branch at unit-label.ts:60-66]

2. **Helper correctness**: `formatUnitSuffix(unit, plural)` and
   `formatPerUnit(value, unit, plural)` at unit-label.ts:24-50. Pluralisation
   handles "sh/ch/x/z" → +es (unit-label.ts:60-66), defaults plural=true,
   no double-pluralisation of already-plural inputs (unit-label.ts:59).
   Covered by formatters/unit-label.test.ts (108 lines, 19 specs, all green).

3. **Guard target coverage**: `decomposers/unit-label-convention.test.ts`
   imports the 5 target decomposers directly (sqs, sns, lambda, dynamodb,
   s3) at lines 30-34 — NOT hardcoded fixtures. Each decomposer is
   exercised across 5 desiredState shapes. Plus 5 explicit named-label
   assertions at lines 96-130 lock down specific labels.

4. **Drift-guard regex strict enough**: `/^\/M [a-z ]+$/` at line 56.
   Rejects: tilde prefix, "/million" spelled out, uppercase, "K"/"G"
   abbreviations, trailing whitespace, leading whitespace. The
   `isPerMillionUnit` classifier (lines 60-66) intentionally over-matches
   (catches `~`, `million`, `/M `) so that any drift introduced in the
   decomposers WOULD trip the strict regex. Good defensive shape.

5. **No regression**: Existing decomposer tests pass unchanged. The
   PriceUnit imports flow through; no inline string templates touched in
   decomposer bodies (verified via `git show … decomposers/{sqs,sns,
lambda,dynamodb}.ts | grep priceUnit`).

6. **CHANGELOG accuracy**: CHANGELOG entry at lines 19-34 correctly
   describes scope (helper + 5 decomposers + snapshot guard) and is honest
   that output is identical. Does NOT claim the strategies-layer was touched.

## Findings

- **Scope claim vs. actual closure (severity: MED)**:
  Commit message and CHANGELOG declare "Epic-106 is now fully closed"
  but the user-visible drift the dogfood quoted —
  `strategies/sns.ts:31 unit: "/million publishes"`,
  `strategies/lambda.ts:26 "~$${total.toFixed(2)}/million req"`,
  `strategies/apigatewayv2.ts:59 unit: "/million messages"` —
  remains untouched. The snapshot guard only walks decomposers, so those
  drift sources will never trip CI. Proposed fix: either (a) tighten the
  closure claim to "Epic-106 decomposer scope closed" and add a follow-up
  story for `strategies/*.ts` cost-label centralisation, or (b) expand
  scope of this work to bring strategies under `formatUnitSuffix` before
  declaring Epic-106 closed.

- **DynamoDB strategy emits non-canonical "/M write req" (singular!)
  (severity: MED)**:
  `packages/core/src/pricing/strategies/dynamodb.ts:65` has
  `unit: "/M write req"` — missing the trailing `s`. This is exactly the
  class of drift the new guard is supposed to catch, but the guard scope
  excludes strategies. Per project rule "Fix everything you find" this
  should be brought into the canonical convention. Proposed fix: import
  `formatUnitSuffix` and replace with `formatUnitSuffix("write req")`
  (or equivalent), and add `strategies/*.ts` outputs to the snapshot
  guard's enumeration set.

- **Helper-test "PriceUnit constant parity" describe block does not
  actually assert PriceUnit byte-identity (severity: LOW)**:
  `formatters/unit-label.test.ts:82-103` is named "PriceUnit constant
  parity" but only asserts `formatUnitSuffix(noun) === literal`. It never
  imports `PriceUnit` and asserts e.g. `PriceUnit.PER_MILLION_REQS === "/M reqs"`.
  So if a future edit changed `price-units.ts:24` to
  `formatUnitSuffix("request")` (yielding "/M requests"), this describe
  block would still pass while silently breaking output. Proposed fix:
  add direct `expect(PriceUnit.PER_MILLION_X).toBe("…")` byte-identity
  assertions, OR rename the describe to something honest like
  "formatUnitSuffix output regression check".

- **Snapshot guard silently swallows decomposer throws (severity: LOW)**:
  `decomposers/unit-label-convention.test.ts:75-78` has
  `try { items = decomposer.decompose(state); } catch { return; }`.
  If a decomposer that SHOULD handle a given state throws (e.g. an
  unintended regression), the test silently passes. The intent (skip
  states a decomposer doesn't accept) is reasonable but the implementation
  is too quiet. Proposed fix: track which (decomposer, state) pairs were
  successfully decomposed and assert at least one decomposed successfully
  per decomposer, OR narrow the catch to a specific expected error class.

- **`formatUnitSuffix("")` returns `"/M s"` (severity: LOW)**:
  Empty-string input pluralises to `"s"`. Probably unreachable with
  current callers (all inputs are hard-coded nouns), but no defensive
  guard or test for the bad-input case. Proposed fix: trim+validate
  non-empty at helper entry, or add a test documenting the current
  behaviour as intentional.

- **Helper's `pluralise()` uses `.toLowerCase()` only to test the
  suffix branch, then concatenates onto the ORIGINAL casing (severity:
  LOW, design note)**:
  `unit-label.ts:55-66` — if a caller passes `"Publish"` (capitalised),
  it returns `"Publishes"`, but the canonical regex `/^\/M [a-z ]+$/`
  rejects uppercase. So uppercase callers would silently break the
  snapshot guard. No current caller does this; worth a one-line
  in-helper assert or a test that exercises uppercase-input → guard-trip
  flow.

## Notes

- Tests verified locally:
  `pnpm --filter @assignee/core test` → 370 files / 9319 tests pass,
  including new `unit-label.test.ts` (19) and `unit-label-convention.test.ts`.
- `git grep -nE "(/M |/million)"` over `packages/core/src/pricing/` confirms
  decomposer-side code is clean; only strategies/ and free.ts comments
  remain (free.ts mentions are docstrings, not output strings).
- Helper introduces no coupling to pricing-API field semantics — it is a
  pure display formatter (good).
- CHANGELOG entry self-includes per `feedback_changelog_self_entry`. Good.
- This is the 9th and final story of Epic-106 in scope of decomposers;
  see scope-claim finding for the strategies-layer caveat.
