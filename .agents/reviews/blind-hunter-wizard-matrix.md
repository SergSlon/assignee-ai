# Blind Hunter Review — wizard-interaction-matrix

Scope: 7 new test files, shared fixture, and two production-code edits.
Focus: shallow-spec bugs where the assertion passes but does not verify what the test name promises.

## Findings

### 1. Intent-rules test does not verify the override actually wins first-match (HIGH)

**File:** `apps/cli/src/__tests__/wizard-matrix-intent-rules.test.ts:102-120`

When two `INTENT_RULES` entries for the same `resourceType` target the same `fieldName`, "first-match-per-field wins". The test iterates `rule.overrides` and only asserts `matched !== undefined` and `matched?.reason` is truthy. It never asserts `matched.value === ov.value` or `matched.reason === ov.reason`. So if `rule N` declares an override for `InstanceType = "c5.xlarge"` but an earlier rule already claimed `InstanceType = "t3.small"`, `getIntentDefaults()` returns the earlier rule's entry, the test finds _a_ match, and silently passes — while the rule under test has been effectively dead-code'd. This is the exact class of bug the story claims to cover ("first-match-per-field semantics hold").

**Fix:** After finding `matched`, also assert that either (a) `matched.value === ov.value && matched.reason === ov.reason` (this rule won), or (b) there is an earlier rule in `INTENT_RULES` for the same `resourceType+fieldName` whose sentinel sentence also matches — in which case skip instead of passing. A simpler form: in `describe.each`, pre-compute an `expectedWinner` map from `(resourceType, fieldName)` → first rule index; only run assertions when the rule under test is the winner for that field.

### 2. Happy-path test silently accepts excess `promptWithHelp` calls by returning undefined (HIGH)

**File:** `apps/cli/src/__tests__/wizard-matrix-happy-path.test.ts:137-163`

The mock implementation does `sequence[callIndex++]?.value` — once `callIndex` exceeds `sequence.length`, every subsequent call returns `undefined`, which option-elicitor treats as a valid empty answer for most types. The only catch is `toHaveBeenCalledTimes(sequence.length)` at line 163. That _would_ catch overshoot, but: if a showIf-guarded field is prompted when it shouldn't be _and_ another visible field is skipped by the same bug, total call count stays equal to `sequence.length` while the identity of what was prompted is wrong. The per-field `answerMap` assertion also won't notice because the skipped field was never in the map.

**Fix:** Track `calledFieldNames` in the mock (push `field.name`), then assert `calledFieldNames` deep-equals the sequence's `field.name` list in order. This catches both overshoot and identity drift.

### 3. Pattern-based showIf conditionals get zero drive-based coverage (MEDIUM)

**File:** `apps/cli/src/__tests__/wizard-matrix-conditionals.test.ts:150-170, 270-300`

For `cond.pattern` branches, `satisfyingValue`/`nonSatisfyingValue` are set to `undefined`, and both driven tests early-return on line 271 / 291. The static invariant test at lines 202-236 exercises `evaluateShowIf` directly, but the wizard integration (does option-elicitor actually hide/show the dependent field for pattern conditions?) is never driven. This matters because `t3.small`-style pattern gates on `InstanceType` are exactly the EC2 family that motivated the back-nav UX fix.

**Fix:** Use `pickPatternMatch` (already defined at line 239) to produce satisfyingValue for pattern conditionals and feed that via `driveFlow`. For non-match, use a concrete string like `"m5.large"` that fails the burstable regex.

### 4. `fetcher` populated-test silently skips any fetcher ID missing from sample table (MEDIUM)

**File:** `apps/cli/src/__tests__/wizard-matrix-fetchers.test.ts:183-184`

`samplePopulatedByCacheKey` covers 7 fetcher IDs. Any plugin that uses a fetcher ID outside this set (e.g., `discover-instance-types` — which returns `null` anyway, different shape — or future `discover-vpcs`) hits `if (!sample) continue;` and the entire "populates options" assertion body is dead for that field. A new fetcher added tomorrow gets auto-enrolled via `PLUGINS_WITH_FETCHERS` but auto-opts-out of the populated assertion. The per-plugin test still passes with zero meaningful checks.

**Fix:** After the loop, assert that for each plugin at least one fetcher field got its assertion exercised, e.g. `expect(assertedFieldCount).toBeGreaterThan(0)` — or (better) fail explicitly when a fetcher ID is encountered that isn't in the sample table, forcing maintainers to update the fixture.

### 5. BP-hint parse falls through silently on format drift (MEDIUM)

**File:** `apps/cli/src/__tests__/wizard-matrix-bp-hints.test.ts:92-96`

The test locates an injected hint by searching for the literal marker `"Recommended by Best Practices: "`. If `injectBPHints` changes its separator (localized, re-worded, made multi-line), `newHint?.includes(marker)` is false, the loop `continue`s, and the "every BP-sourced hint matches a BP whose property_path contains the field name" assertion never fires — yet the describe title implies it audits every injected hint. Coupled with the awareness-BP check (which also relies on finding the title substring), a format change would silently gut BP-hint accuracy enforcement.

**Fix:** Before the main loop, compute the set of fields for which `hintedAll[i].question.hint !== original.hint` AND assert that number equals the count of fields that matched the marker. Or: expose a structured `injectedBp` ref on the field (test-only field or metadata map) so parsing isn't needed.

### 6. Happy-path `answerMap` check does not catch wrong-field leakage (MEDIUM)

**File:** `apps/cli/src/__tests__/wizard-matrix-happy-path.test.ts:154-160`

The loop asserts every answered field appears in `elicitedOptions`. But it never asserts the _converse_: that `elicitedOptions` contains no extra keys beyond `answerMap`. If option-elicitor accidentally injects a phantom field (e.g., a leftover from applied intent defaults, a companion field, a stale cache) the test passes because the `for` loop only walks known answers.

**Fix:** After the forward loop, assert the key-set of `result.elicitedOptions` is a subset of the union of `answerMap` keys plus any known-allowed extras (runId, metadata). Use `Object.keys(result.elicitedOptions!).sort()` in the assertion message for rapid diagnosis.

### 7. Non-matching-intent test only guards keywords of the rule under test (LOW)

**File:** `apps/cli/src/__tests__/wizard-matrix-intent-rules.test.ts:151-166`

The "unrelated" sentence `"zzz unrelated qqq nothing matches here"` is verified to not contain _this rule's_ keywords, but other rules for the same `resourceType` could match a word in the sentence (none do today — checked). The assertion `expect(result.length).toBe(0)` is stricter than the sanity check protects. A future rule with keyword `"here"`, `"matches"`, or `"nothing"` would flip this assertion to a false negative against the wrong rule.

**Fix:** Also verify the sentinel sentence contains none of the keywords from any rule sharing the resource type, not just the current one. Or use random UUIDs as tokens: `` `${crypto.randomUUID()} ${crypto.randomUUID()}` ``.

### 8. `companionResources()` well-formed test vacuously passes when array is empty (LOW)

**File:** `apps/cli/src/__tests__/wizard-matrix-companions.test.ts:149-159`

Called with `{}` desiredState, many plugins (e.g., ECS::Cluster — see line 134 explicitly asserting `length === 0` for this exact case) return `[]`. The `for (const out of outputs)` loop then runs zero iterations and the test passes trivially. Its title, "returns an array of well-formed CfnOutput objects", promises structural validation that never happens for any of the 16 tested plugins unless they happen to emit companions on empty state.

**Fix:** Drive the loop with a per-plugin minimal `desiredState` (similar to `generateDefaultAnswer` — a helper already exists in fixtures). At minimum assert `expect(outputs.length).toBeGreaterThan(0)` for the known subset (ECS::Cluster with ClusterName, RDS with SecretName, etc.), and only run "well-formed" on plugins that actually produce output.

### 9. Multi-field Back propagation test does not verify user-visible behavior (LOW)

**File:** `apps/cli/src/__tests__/wizard-matrix-back-nav.test.ts:293-307`

The test asserts the renderer returns an array containing BACK_SENTINEL, but the inline comment admits unwrapping is "the option-elicitor's promptWithHelp wrapper['s] responsibility". So a bug where promptWithHelp fails to unwrap `[BACK_SENTINEL]` → `BACK_SENTINEL` leaves multi-field users stuck, and nothing in this file catches it. The describe title "selecting Back returns BACK_SENTINEL" overstates what's verified.

**Fix:** Add one end-to-end assertion in `wizard-matrix-back-nav.test.ts` (or point to an existing test in `option-elicitor.test.ts`) that exercises `promptWithHelp` on a `multi` field and asserts the returned value is strictly `BACK_SENTINEL` (not `[BACK_SENTINEL]`).

### 10. `generateDefaultAnswer` for enum with only a fetcher (no static options) returns a synthetic string (LOW / fixture drift)

**File:** `apps/cli/src/__tests__/fixtures/wizard-matrix-plugins.ts:164-167`

`case "enum": { const first = q.options?.[0]?.value; return first ?? ${field.name.toLowerCase()}-value; }`. For a pure-fetcher enum field with empty `options` array (common pattern — e.g., subnets), the default becomes the literal string `"subnetid-value"`. In happy-path, that gets asserted as the elicitedOptions value — the test passes, but the wizard would reject this as a non-matching enum choice if `resolveDynamicFields` had populated real options. Because the happy-path test also mocks all discovery to return `[]`, the enum becomes type `string` at runtime so the junk value is accepted. This hides a subtle drift: when a plugin adds a new enum+fetcher field with a non-empty static fallback, the fixture's fallback answer is never actually what the user could have selected.

**Fix:** In `generateDefaultAnswer`, if the field has a fetcher AND no static options, return `undefined` — forcing the test to configure a populated fetcher or skip the field deliberately.

---

## Not flagged (considered and dismissed)

- Shared `vi.mock` surface duplicated across 3 files — style only; each file is hermetic.
- `showIfSatisfied` / `evaluateShowIf` cross-check — genuinely catches fixture drift (good defensive test).
- `INTENT_RULES.length >= 30` guardrail — reasonable regression guard; not shallow.
- `ALL_PLUGINS.length >= 23` — same.
- SNS plugin `ContentBasedDeduplication` field addition — production change is a straightforward advanced field; no hidden bug.
- ECS Fargate rule `CLUSTER_SETTINGS → CONTAINER_INSIGHTS` — verified `CONTAINER_INSIGHTS` is the real field name in the ECS plugin; the fix is legitimate.

## Summary

10 findings: 2 HIGH, 4 MEDIUM, 4 LOW. The HIGH items (#1, #2) both allow real production bugs to pass silently: a dead intent rule and a prompted-field identity drift. #3 leaves pattern showIf (the EC2 burstable family) without driven coverage. The remaining findings are coverage gaps that vacuously pass when the underlying surface is empty or differently formatted. No findings in the companions toCfn-specific tests (EC2::NatGateway / EC2::RouteTable) — those are well-scoped and assert the important branches.
