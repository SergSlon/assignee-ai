# QA Review — Test Coverage for 2026-04-11 Nightly Fix Batch

Scope: 6-file diff covering plan-generator branch, result-formatter ARN propagation, tags alternate-key handling, three-tier-web defaults, and EFS plugin field rename. Grading coverage/assertion strength only — not code quality.

## Verdict Summary

| #   | Fix                                                          | Status   | Severity |
| --- | ------------------------------------------------------------ | -------- | -------- |
| 1   | plan-generator: provisionable=false → placeholder resolution | **GAP**  | HIGH     |
| 2   | result-formatter: propagate displayArn in single-SUCCESS     | **GAP**  | HIGH     |
| 3   | tags.ts: ALTERNATE_TAG_KEY_TYPES (EFS→FileSystemTags)        | **GAP**  | CRITICAL |
| 4   | three-tier-web: ALB_SG/APP_SG GroupDescription defaults      | **GAP**  | HIGH     |
| 5   | efs-file-system plugin: field name CfnKey.FILE_SYSTEM_TAGS   | **WEAK** | MEDIUM   |

No existing unit test fails after these fixes because no test pins the new behavior. Regression risk is high; every fix is essentially untested.

---

## Fix #1 — plan-generator.ts, provisionable:false branch

**GAP — HIGH.** I grepped `apps/cli/src/nodes/plan-generator.test.ts` for `provisionable`, `resolveCompoundMarkers`, `resolvePlaceholderMarkers`, `LAMBDA_INTEGRATION`. The file uses `resolveCompoundMarkers` directly for its own VPC tests (lines 1401–1692), but NOTHING exercises `createPlanGeneratorNode` with a `currentResource` whose `provisionable === false` to prove the dispatch switches paths. `apps/cli/src/nodes/__tests__/compound-provisioning-audit.test.ts` only asserts the dispatcher _queues_ provisionable:false resources (lines 1134, 1159); it never verifies marker resolution path.

The original serverless-api bug ("dependency http-api completed without a physical identifier") would NOT have been caught — no test wires up a companion resource with a `markerRef` pointing at another `provisionable:false` parent and runs the plan-generator node in APPLY mode.

**Proposed test** (add to `apps/cli/src/nodes/plan-generator.test.ts`): Build a state where `currentResource = { resourceId: 'lambda-integration', provisionable: false }`, `executionMode: ExecutionMode.APPLY`, `desiredState` containing a `markerRef(HTTP_API)` token, and `completedResources` containing `http-api` with `resourceArn: undefined` (the real bug shape). Assert the node resolves successfully (no throw) and that the marker field is a human-readable placeholder string, NOT the raw marker token. Mirror test in compound-provisioning-audit.test.ts asserting "provisionable:false companions never hit resolveCompoundMarkers even in APPLY mode" — spy on both resolver functions.

---

## Fix #2 — result-formatter.ts, `{ resourceArn: displayArn }` return

**GAP — HIGH.** The existing test at line 224 (`"does NOT mutate state.resourceArn…"`) pins the opposite invariant: state itself must not mutate. The test at line 197 uses an already-full ARN (`arn:aws:iam::123456789012:role/my-role`), so `displayArn === state.resourceArn` and the new branch is NEVER taken. Every `expect(result).toEqual({})` assertion in SUCCESS branches uses pre-ARN values, so the new `return { resourceArn: displayArn }` path has zero coverage.

The original bug ("final state lacks full ARN after SSM apply") would NOT have been caught — no test feeds a bare CCAPI identifier like `/app/env/key` through result-formatter and asserts the returned partial state contains a full ARN.

**Proposed test** (add to `apps/cli/src/nodes/result-formatter.test.ts`, adjacent to line 243): With `resourceType: 'AWS::SSM::Parameter'`, `resourceArn: '/poc/test/greeting'`, mock `resolveResourceArn` (or seed real STS mock) to return `arn:aws:ssm:us-east-1:123456789012:parameter/poc/test/greeting`. Assert `result.resourceArn === 'arn:aws:ssm:us-east-1:123456789012:parameter/poc/test/greeting'` AND `state.resourceArn === '/poc/test/greeting'` (state unchanged). Add a second test for the no-op case: when `displayArn === state.resourceArn`, `result` is `{}` (pins the conditional boundary).

---

## Fix #3 — tags.ts, ALTERNATE_TAG_KEY_TYPES (EFS)

**GAP — CRITICAL.** `apps/cli/src/utils/tags.test.ts` has zero EFS coverage — I read the full 100-line file. Nothing references `FileSystemTags`, `EFS`, `EFS_FILE_SYSTEM`, or the alternate-key concept. All four required cases (a–d in the brief) are uncovered:

- (a) EFS → FileSystemTags populated: untested
- (b) stray `Tags` key deleted: untested (the `delete output[CfnKey.TAGS]` line has no test)
- (c) existing FileSystemTags preserved + merged: untested
- (d) existing `Tags` migrated into FileSystemTags: untested

The original bug (`extraneous key [Tags] is not permitted` against EFS at CCAPI) would have been caught instantly by any of (a) or (b). This is the most dangerous gap in the batch because EFS destroy and retry loops will silently degrade if someone reverts `ALTERNATE_TAG_KEY_TYPES`.

**Proposed tests** (new `describe("AWS::EFS::FileSystem — alternate tag key")` block in `apps/cli/src/utils/tags.test.ts`):

1. `"writes FileSystemTags and emits NO top-level Tags"` — input `{ PerformanceMode: 'generalPurpose' }`, assert `result.FileSystemTags` is a CfnTag[] containing the 3 mandatory tags and `'Tags' in result === false`.
2. `"migrates pre-existing top-level Tags into FileSystemTags"` — input `{ Tags: [{ Key: 'team', Value: 'platform' }] }`, assert `result.FileSystemTags` contains both `team=platform` and the mandatory tags, and `result.Tags === undefined`.
3. `"merges pre-existing FileSystemTags with mandatory tags, mandatory wins duplicates"` — input `{ FileSystemTags: [{ Key: 'Name', Value: 'vol-a' }, { Key: 'environment', Value: 'staging' }] }`, assert `Name=vol-a` preserved AND `environment=poc` (mandatory overwrite).
4. `"merges BOTH stray Tags AND existing FileSystemTags in one pass"` — input with both properties populated; assert single merged array at `FileSystemTags`, no `Tags`, no duplicates.

All four must pass real CfnTag[] shapes, not stub `{}`.

---

## Fix #4 — three-tier-web.ts, GroupDescription defaults

**GAP — HIGH.** No `three-tier-web.test.ts` file exists in `packages/core/src/pattern-templates/patterns/`. The only reference in `serverless-api.test.ts:41` is a keyword-detection assertion — it does NOT inspect `defaultOptions`. Contrast with `vpc-networking.test.ts:107` and `efs-with-vpc.test.ts:94` which both have `"every dependencyOrder id has a defaultOptions entry"` assertions. three-tier-web has no such guard.

The original bug (`required key [GroupDescription] not found`) would have been caught by ANY pattern-validation test that iterated commonFields with `required: true` per resource type and asserted each required key appears in `defaultOptions[resourceId]`.

**Proposed tests** (new `packages/core/src/pattern-templates/patterns/three-tier-web.test.ts`):

1. `"every dependencyOrder id has a defaultOptions entry"` — mirror `efs-with-vpc.test.ts:94`.
2. `"ALB_SG defaultOptions contains GroupDescription"` — `expect(pattern.defaultOptions[R.ALB_SG]?.[CfnKey.GROUP_DESCRIPTION]).toBeTypeOf('string')` AND `.length > 0` (not vague `toBeDefined`).
3. `"APP_SG defaultOptions contains GroupDescription"` — same.
4. **Cross-pattern guard** (add to `packages/core/src/pattern-templates/registry.test.ts`): for every registered pattern, for every resource in `resources[]`, load the resource plugin's `commonFields` and assert every `required: true` field has a corresponding key in `defaultOptions[resourceId]`. This single test would have caught #4 AND would catch the same class of bug in future patterns.

---

## Fix #5 — efs-file-system.ts, field name rename

**WEAK — MEDIUM.** `efs-file-system.test.ts` was updated to look up the field by `CfnKey.FILE_SYSTEM_TAGS` (lines 16, 45, 79), but the assertions only check metadata (`required: true`, validation regex, `toCfn` output shape). There is no end-to-end test that plan-generator runs the EFS field pipeline and asserts the resulting `desiredState.FileSystemTags` matches the expected shape (and `desiredState.Name` is absent). `configHints` test at line 263 only asserts the string `"FileSystemTags"` appears in the hint text — a pure documentation test.

The coupling between field.name being the output property key (`transformed[field.name] = field.toCfn(answer)` in plan-generator) is load-bearing and undocumented in tests. If someone renames the CfnKey constant, the test still passes as long as it resolves consistently.

**Proposed test** (add to `packages/core/src/resource-plugins/plugins/efs-file-system.test.ts`): `"plugin produces desiredState.FileSystemTags and no Name key when processed via field pipeline"`. Invoke the same `transformed[field.name] = field.toCfn(answer)` logic the plan-generator uses (or call the real helper if exported) with `answer = 'my-vol'`. Assert `transformed.FileSystemTags === [{ Key: 'Name', Value: 'my-vol' }]` AND `'Name' in transformed === false`. Pin the exact property layout — this is the invariant CCAPI cares about.

Also add a compound-flow test in `packages/core/src/pattern-templates/patterns/efs-with-vpc.test.ts` asserting the final EFS `desiredState` includes `FileSystemTags` with mandatory tags merged and NO top-level `Tags` or `Name` keys. This is the only test that would have caught the original nightly failure end-to-end.

---

## Assertion Quality Notes

- `tags.test.ts` uses real CfnTag shapes — GOOD. Add EFS cases in the same style.
- `result-formatter.test.ts` leans heavily on `toEqual({})` — acceptable for negative cases, but the new positive case needs `result.resourceArn === '<exact full ARN>'`, not `expect(result.resourceArn).toBeDefined()`.
- `efs-file-system.test.ts` `configHints` check (line 263) uses `toMatch(/FileSystemTags/)` — this is a substring test and would pass even if the hint said "do NOT use FileSystemTags". Tighten to pin the full guidance sentence, or replace with a structural desiredState test.
- Pattern tests use `toBeTypeOf('object')` for defaultOptions entries (vpc-networking.test.ts:110). Good as a guard, but not strong enough to catch missing required fields — hence Fix #4's cross-pattern guard recommendation.

## Top 3 Must-Add Tests (priority order)

1. **EFS FileSystemTags migration/merge suite** in `tags.test.ts` — 4 cases covering (a)(b)(c)(d). CRITICAL, protects against silent CCAPI rejections on EFS apply.
2. **Cross-pattern required-field guard** in `registry.test.ts` — iterates all patterns × all resources × all `required: true` commonFields. HIGH, prevents the entire class of "pattern skipped wizard, missed required field" bugs.
3. **plan-generator provisionable:false branch test** — asserts `resolvePlaceholderMarkers` path is taken in APPLY mode for companion resources whose parent has no `resourceArn`. HIGH, prevents serverless-api regression.
