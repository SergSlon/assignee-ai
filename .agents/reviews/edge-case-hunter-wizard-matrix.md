# Edge Case Hunter — wizard-interaction-matrix

Findings from boundary/branch walk of the 7 new test files + fixture.

---

## 1. Pattern-based showIf is completely uncovered at the drive level

**File:** `apps/cli/src/__tests__/wizard-matrix-conditionals.test.ts:270-301` (+ fixture `wizard-matrix-plugins.ts:131-135`)

Both `collectConditionalPairs` and `generateAnswerSequence` set `satisfyingValue = undefined` for any `showIf.pattern` condition and early-return the driven tests. `showIfSatisfied` and `generateAnswerSequence` never feed a real string into a pattern-gated child either — so for e.g. the EC2 burstable `^t[34]` pattern (CpuCredits shown only for t3/t4g), **no happy-path test ever prompts CpuCredits**.

**Bug it hides:** regression changing `^t[34]` → `^t[5]` (or inverting the regex) would still pass every test: the static invariant only exercises the fixture's own `pickPatternMatch` heuristic, and the driven tests bail out.

**Fix:** in `generateDefaultAnswer`, when a field has `showIf.pattern` against a parent, pre-populate the parent with a pattern-matching sample (reuse `pickPatternMatch`) in the sequence generator. Add at least one driven conditional row that picks `t3.small` for InstanceType and asserts CpuCredits is prompted.

---

## 2. `generateDefaultAnswer` returns `undefined` for unknown/compound field types

**File:** `wizard-matrix-plugins.ts:157-181`

The `default:` branch returns `undefined`. In `generateAnswerSequence:214`, `undefined` values are NOT recorded in `answerMap`, but the sequence still pushes a row that happy-path feeds to `promptWithHelp`, returning `undefined`. Option-elicitor drops undefined answers, so the assertion loop at happy-path.test.ts:154 is vacuous for that field (nothing to assert).

**Bug it hides:** a plugin adding a new `type: "json" | "number" | "tags"` field would silently produce zero assertions — a broken serializer for the new type would pass.

**Fix:** fail loudly — in `generateDefaultAnswer`, `throw new Error(\`wizard-matrix: unsupported field type ${q.type}\`)` so new field types force a fixture update.

---

## 3. `multi` default `[]` is always dropped, so "multi" rows never assert anything

**File:** `wizard-matrix-plugins.ts:170` + `wizard-matrix-happy-path.test.ts:154-160`

`multi` → `[]`. Happy-path skips `val === undefined || val === ""` but does NOT skip empty arrays — yet option-elicitor drops empty arrays too (see `elicitedOptions` filter in `option-elicitor.ts`). Result: every multi field rolls out of the assertion on both sides, so no happy-path test for Tags/SecurityGroupIds/etc. actually verifies elicitedOptions.

**Fix:** return a realistic non-empty array (e.g. `[q.options?.[0]?.value]` when options exist) OR explicitly assert multi fields map to `[]` in `elicitedOptions ?? {}` (pick one and document).

---

## 4. Intent-rule test assumes first-match-per-field but never asserts it

**File:** `wizard-matrix-intent-rules.test.ts:102-120`

The test uses `⊇` semantics ("matched?.reason be truthy") and explicitly permits the matched reason to come from "an earlier rule for the same field". It therefore passes even if a later rule silently clobbers an earlier one — the exact regression first-match-per-field is supposed to prevent.

**Bug it hides:** flipping the INTENT_RULES iteration to last-match-wins would pass every test as long as _some_ rule wrote a reason.

**Fix:** Add a targeted test with two synthetic rules for the same resourceType+fieldName where first has `reason: "A"` and second has `reason: "B"`, assert `getIntentDefaults` returns `reason: "A"` against an intent matching both.

---

## 5. Intent-rule "non-matching" test picks a nonsense sentence, ignoring cross-rule overlap

**File:** `wizard-matrix-intent-rules.test.ts:151-166`

The test's sanity check only verifies the CURRENT rule's keywords are absent — but another rule for the same resourceType whose keyword _is_ in the nonsense string would make `result.length === 0` fail. `"zzz unrelated qqq nothing matches here"` contains the substring `"zz"`, `"here"`, etc. and is fragile if any future rule uses those tokens.

**Fix:** Check ALL rules' keywords against the sentence (not just the current rule's), or use a deterministic Unicode-only nonsense string like `"\u0001\u0002\u0003"`.

---

## 6. Intent-rule value-equality uses `toEqual` but misses reference semantics for arrays

**File:** `wizard-matrix-intent-rules.test.ts:139`

`expect(enrichedField?.question.initialValue).toEqual(ov.value)` uses deep equality, which is correct — but `applyIntentOverrides` may legitimately need to CLONE array/object values (else two fields sharing a reference to the same array get cross-contaminated when one is mutated by later config layers). No test checks whether initialValue and ov.value are the SAME reference or cloned.

**Fix:** Add one assertion for a rule whose `value` is an array: `expect(enrichedField?.question.initialValue).not.toBe(ov.value)` — or document that sharing is intentional.

---

## 7. BP hint test fails open when there are zero relevant BPs

**File:** `wizard-matrix-bp-hints.test.ts:42-124`

Both "never injects awareness" and "matched property_path contains field name" iterate `hintedAll` and assert inside the loop. For a plugin where NO BP is ever injected (loop body never runs), the test passes with zero effective assertions. Combined with the silent filter `if (newHint === originalHint) continue;` — a regression that breaks `injectBPHints` into a no-op would make **every** plugin's test pass.

**Fix:** Add an invariant: for `ALL_PLUGINS`, assert that at least some total count of BP hints are injected across the matrix (`expect(totalInjected).toBeGreaterThan(N)`), or per-plugin `expect.hasAssertions()` only for plugins whose relevantBPs array is non-empty and non-awareness.

---

## 8. BP segment-containment check is too permissive for nested paths

**File:** `wizard-matrix-bp-hints.test.ts:115-118`

`segments.includes(field.name)` passes for `property_path = "Tags.Owner"` against a field named `"Owner"` — even though the field that should get the hint is `Tags`, not `Owner`. This is exactly the "BP targets a parent field, segments accidentally match a leaf" case the task called out.

**Bug it hides:** if a plugin adds a leaf field named `Owner` and a BP has property_path `Tags.Owner`, the BP would be attached to the Owner leaf AND pass this test — but at runtime it would guide the wrong prompt.

**Fix:** assert the matched segment is specifically `segments[0]` OR the exact property_path, not any interior segment: `matches = matchedBp.property_path === field.name || segments[0] === field.name`.

---

## 9. Fetcher "graceful fallback" has an escape hatch that swallows every bug

**File:** `wizard-matrix-fetchers.test.ts:156-161`

```
expect(["string", original.question.type]).toContain(after?.question.type);
```

This accepts either the transformed string OR the unchanged original type — for fetcher IDs not in `fetcherMap` (like "discover-vpcs", "discover-availability-zones" per the helpful comment). That means if `resolveDynamicFields` silently **stops calling ANY fetcher** (bug), the type stays as-original and this test still passes for all those plugins.

**Fix:** Split the two cases: for known-registered fetcher IDs, require `type === "string"` (or enum with fallback options). For un-registered IDs, add an explicit allowlist check and a separate assertion that `fetcher` marker is still present or removed deterministically.

---

## 10. Fetcher "populated" test silently skips uncovered fetcher IDs

**File:** `wizard-matrix-fetchers.test.ts:181-184`

`if (!sample) continue;` skips any fetcher whose ID is missing from `samplePopulatedByCacheKey`. New fetchers added to a plugin (say `discover-efs-throughput`) would cause zero populated-path coverage, silently.

**Fix:** `expect(samplePopulatedByCacheKey).toHaveProperty(id)` at the top of the loop to force fixture updates when a fetcher is added.

---

## 11. Back-nav: `clack.text` returning empty string `""` is untested

**File:** `wizard-matrix-back-nav.test.ts:280-291`

Test #281 covers `text → "back"` → BACK_SENTINEL. But what about `text → ""` (user presses enter immediately)? That's the EC2+SSH scenario: empty-string result must NOT be confused with BACK_SENTINEL, and must NOT be dropped into an infinite loop. No test covers this.

**Fix:** Add `vi.mocked(clack.text).mockResolvedValueOnce("")` and assert `result === ""` (or whatever the defined behavior is — undefined vs empty-string collapse is the bug class).

---

## 12. Back-nav: boolean `showBack=true` with `initialValue: undefined` untested

**File:** `wizard-matrix-back-nav.test.ts:80-84, 136-145`

`booleanField` is defined with `initialValue: true`. Every boolean test passes `makeResolved(true)`. No test covers `{ type: "boolean", initialValue: undefined }` with `makeResolved(undefined)` — the case where the user has no default and hits Back immediately. Boolean + showBack routes through `clack.select` (not confirm) so the default-selection logic for an undefined initial is branch-specific.

**Fix:** Add `makeResolved(undefined)` case for booleanField with `showBack=true` and assert the select call's `initialValue` is sensible (the "true" option, not `undefined` which would crash `@clack/prompts`).

---

## 13. Conditionals test: mock implementation leaks across `it.each` rows

**File:** `wizard-matrix-conditionals.test.ts:109, 318-323`

`beforeEach` runs `vi.clearAllMocks()` which clears call history but **does NOT reset `mockImplementation`** (that requires `vi.resetAllMocks()` or `mockReset()`). `driveFlow` re-sets the implementation every call, which masks the issue for this file — BUT the shared mock module (`wizard-helpers.js`) is also imported by happy-path tests running in the same process. If tests run in parallel within a worker, one `mockImplementation` from conditionals can be observed by a happy-path test before its own `mockImplementation` runs.

**Bug it hides:** flaky cross-file interference; appears as "sequence[0] is undefined" in CI under load.

**Fix:** switch `beforeEach` to `vi.resetAllMocks()` (resets impls too) OR use `vi.mocked(promptWithHelp).mockReset()` explicitly in each file. Also consider file-level isolation via `test.concurrent` opt-out.

---

## 14. Companion test for empty desiredState doesn't cover partial state

**File:** `wizard-matrix-companions.test.ts:141-160`

The generic `companionResources({})` test only exercises the empty-object branch. Per the task prompt: what if `companionResources()` depends on a field that's not in desiredState? E.g., RDS auto-secret companion keys off `MasterUsername` — with `{}` it returns `[]`, but with `{ Engine: "postgres" }` (partial) an implementation bug could throw.

**Fix:** Add a second row per plugin: `plugin.companionResources!({ SomeUnrelatedKey: "x" })` must not throw. Better: per-plugin targeted assertions driven from a small companion expectations table (RDS + engine → secret, ECS + ClusterName → log group already exists).

---

## 15. Happy-path tests never assert prompt ORDER

**File:** `wizard-matrix-happy-path.test.ts:137-164`

`callIndex` advances linearly, but there's no assertion that `promptWithHelp` was called with fields in `commonFields` order followed by `advancedFields` order. A bug that prompts advanced fields before common (breaking showIf which depends on earlier answers) would still pass every test because `sequence` is generated in the SAME (possibly wrong) order and the values happen to line up positionally.

**Fix:** Capture `mock.calls.map(c => c[0].name)` and `expect(...).toEqual(expectedOrderedNames)` derived from the fixture's sequence.

---

End. 15 findings, ~790 words.
