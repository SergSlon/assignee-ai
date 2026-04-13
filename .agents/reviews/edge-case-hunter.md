# Edge Case Hunter — 6-file bug-fix diff

Scope: `apps/cli/src/utils/tags.ts`, `apps/cli/src/nodes/plan-generator.ts`,
`apps/cli/src/nodes/result-formatter.ts`,
`packages/core/src/pattern-templates/patterns/three-tier-web.ts`,
`packages/core/src/resource-plugins/plugins/efs-file-system.ts` (+test).

Only unhandled boundary conditions are reported. Severity reflects
likelihood × blast radius.

---

## CRITICAL

### C1. three-tier-web ALB still has no Subnets → apply fails at ELBv2, not SG

**File**: `packages/core/src/pattern-templates/patterns/three-tier-web.ts:83-86`
**Boundary**: compound `defaultOptions` injection path.

`AWS::ElasticLoadBalancingV2::LoadBalancer` REQUIRES `Subnets`
(min 2 AZs — see `elbv2-loadbalancer.ts:168` configHint). The fix only
added `GroupDescription` for the two SGs; the ALB entry still has only
`Type` + `Scheme`. The pattern's comment says "default VPC is used when
absent" but ALB is not EC2 SG — there is no implicit-default-subnet
fallback for ELBv2. The nightly will now progress past the SG step and
fail at the ALB step with `required key [Subnets] not found`. The fix
is incomplete: every compound-required field on every resource must be
populated, not just the two the test happened to trip on.

### C2. EC2 Instance missing SubnetId + SecurityGroupIds + ImageId wiring

**File**: `packages/core/src/pattern-templates/patterns/three-tier-web.ts:79-82`
**Boundary**: compound default wiring.

`R.EC2_INSTANCE` defaultOptions sets only `InstanceType` and `HttpTokens`.
There is no `SubnetId`, no `SecurityGroupIds` referencing `APP_SG`, no
`ImageId`. AWS will either 400 at CCAPI or pick an arbitrary default VPC
subnet — but the SG linkage is silently lost, meaning the whole point of
the three-tier topology (ALB→APP_SG→EC2) never works. Same pattern
as C1: the fix only addresses the immediate preflight failure, not
the dependency graph.

### C3. EFS required-field loophole: `FileSystemTags` lost on compound path

**File**: `packages/core/src/resource-plugins/plugins/efs-file-system.ts:46`

- `packages/core/src/pattern-templates/patterns/efs-with-vpc.ts:196-201`
  **Boundary**: `required: true` field with no corresponding `plugin.defaults`
  entry AND no `pattern.defaultOptions` entry.

The renamed field `name: CfnKey.FILE_SYSTEM_TAGS` is `required: true`, but
`efs-file-system.ts` `defaults: {...}` has NO entry for `FILE_SYSTEM_TAGS`,
and `efs-with-vpc.ts` defaultOptions for `R.EFS_FILE_SYSTEM` only sets
Encrypted/PerformanceMode/ThroughputMode/BackupPolicy. The compound
plugin-defaults injection at `plan-generator.ts:902-915` will NOT inject
`FileSystemTags` (nothing in plugin.defaults), so the resource's
`desiredState.FileSystemTags` is undefined going into
`injectMandatoryTags`. Apply still "succeeds" because CCAPI EFS does not
require FileSystemTags — but the user-visible "Name" tag is never set.
The old test at `efs-file-system.test.ts:16` asserted `required === true`
with the expectation that compound-defaults injection would cover it;
that contract is now broken for compound flow.

### C4. EFS wizard-path user Tags are silently dropped

**File**: `packages/core/src/resource-plugins/plugins/efs-file-system.ts:127-145`

- `apps/cli/src/nodes/plan-generator.ts:1242-1247`
  **Boundary**: schema sanitization runs between `transformFieldsToCfn` and
  `injectMandatoryTags`.

Wizard flow writes `transformed[CfnKey.TAGS] = [{Key:"env",Value:"prod"}]`.
`sanitizeDesiredState` (plan-generator.ts:1243) strips non-schema keys.
EFS schema has NO top-level `Tags` property (configHint line 236 says
exactly this). So the user's Tags field is stripped by sanitize BEFORE
`injectMandatoryTags` sees it. `existingFromStandard` is therefore
ALWAYS empty for EFS, regardless of what the user typed. The fix's
"merge from both keys" logic never fires for the standard key on EFS —
it only protects against some other future caller injecting into Tags
post-sanitize. User-entered EFS tags are silently lost.

---

## HIGH

### H1. `provisionable: true` resource referencing `provisionable: false` companion still throws

**File**: `apps/cli/src/nodes/plan-generator.ts:808-822`
**Boundary**: mixed-provisionability cross-references.

The fix only checks `currentResource.provisionable === false` — i.e.
"am I a companion?". It does NOT protect the case where a provisionable
resource references a non-provisionable companion. In `serverless-api`
today every non-provisionable companion references other
non-provisionable companions, so the fix works — but the moment a new
pattern adds a provisionable resource (say, a Lambda alias) that uses
`markerRef(R.HTTP_API)`, `resolveCompoundMarkers` will throw at line
577-582: "dependency 'http-api' completed without a physical
identifier". The comment in the diff actually documents this failure
mode but doesn't guard against it.

**Repro**: any future pattern with a CCAPI-provisionable consumer of an
API Gateway v2 Api. No test pins the invariant.

### H2. Result-formatter partial update can corrupt the next compound iteration if SUCCESS is ever reached pre-compound-branch

**File**: `apps/cli/src/nodes/result-formatter.ts:482-484`
**Boundary**: code reachability assumption.

The new `return { resourceArn: displayArn }` sits at line 482, AFTER the
compound branch returns at line 387. Today this means compound flows
can never reach it. BUT the single-resource branch `break`s instead of
returning (line 486), and the compound-resource branch returns a
partial early. If a future refactor moves any compound logic below the
security-posture block (line 464), the partial ARN update will leak
into `state.resourceArn` and the next iteration of `resolveCompoundMarkers`
will substitute the full ARN into VpcId / SubnetId / IgwId fields —
re-opening the original Wave 8 P0 bug. There is no assertion pinning
"compound must return before line 482". Add a
`assert(!state.resourcePattern)` or an early-continue guard.

### H3. Regression test at line 224 no longer covers the mutation path it was designed to pin

**File**: `apps/cli/src/nodes/result-formatter.test.ts:224-242`
**Boundary**: test semantic drift after behavioral change.

The test only asserts `state.resourceArn` on the INPUT state object is
unchanged. It does NOT assert on `result.resourceArn`. Post-fix, the
function now returns `{ resourceArn: "arn:aws:s3:::my-smoke-bucket-…"}`
for the S3 case in the test — which, when LangGraph applies the
reducer, mutates the merged graph state. The test happily passes because
the input reference is untouched, but the INVARIANT it was written to
defend ("never propagate full ARN into state.resourceArn") is now
violated for single-resource mode. The test title and comment no
longer match behavior. Either the fix weakens the invariant (and the
test/comment must be updated) or the fix is wrong.

### H4. `alternateTagKey === CfnKey.TAGS` edge case deletes the merge

**File**: `apps/cli/src/utils/tags.ts:159-170`
**Boundary**: future ALTERNATE_TAG_KEY_TYPES entries.

If someone adds `[RESOURCE_TYPES.FOO, "Tags"]` to
`ALTERNATE_TAG_KEY_TYPES` (e.g. to force a resource onto the standard
key), the code sets `output["Tags"] = mergedTags` THEN executes
`delete output[CfnKey.TAGS]` (which IS "Tags"). Net result: tags
vanish. Guard with `if (alternateTagKey && alternateTagKey !== CfnKey.TAGS)`.

---

## MEDIUM

### M1. `injectMandatoryTags` does not defend against `Tags` being present as a non-array non-object (string / number / null)

**File**: `apps/cli/src/utils/tags.ts:146-148`
**Boundary**: malformed desiredState.

`existingFromStandard` uses `Array.isArray(...) ? ... : []`. Fine for
string/object — they become []. But the subsequent `output = {
...desiredState, [tagPropertyKey]: mergedTags }` still carries the
stray bogus `Tags` property through when `alternateTagKey` is
`undefined` (non-EFS). If a malformed plan writes `Tags: "env:prod"`
(string), the function preserves the string AND writes `mergedTags` to
the same key via spread → key collision → mergedTags wins, but any
partial mutation of the upstream desiredState will see "Tags" flip
between types. Low impact but worth a defensive type check.

### M2. `existingTags` with duplicate Keys on the alternate path

**File**: `apps/cli/src/utils/tags.ts:155-158`
**Boundary**: Map dedup order.

`existingFromStandard.concat(existingFromAlternate)` then
`for (tag of existingTags) tagMap.set(tag.Key, tag.Value)`. If
`existingFromStandard` has `{Key:"Name",Value:"from-user"}` and
`existingFromAlternate` has `{Key:"Name",Value:"from-plugin"}`, the
alternate WINS (inserted later). For EFS that means plugin/pattern
defaults override user wizard input. No test covers this precedence,
and it's the opposite of how users would expect ("I typed it, it
should win"). Pre-existing conventionally for standalone Tags
(mandatory override user), but for a user-typed Name field it's
surprising.

### M3. `resolvePlaceholderMarkers` mutates in place; compound-retry could double-resolve

**File**: `apps/cli/src/nodes/plan-generator.ts:507-546`
**Boundary**: re-entry on retry.

`resolvePlaceholderMarkers` mutates `desiredState` in place (line 545).
If the graph re-enters plan-generator for the same resource (e.g.
after a preflight failure auto-fix + retry), the markers are already
replaced with `(from http-api)` strings — `parseMarker()` returns
null for those, so they pass through unchanged. Idempotent, but the
side-effect-on-state surprises future refactors. Not a bug, just
fragile.

### M4. three-tier-web `APP_SG` description implies "ingress from ALB" but no SG rule exists

**File**: `packages/core/src/pattern-templates/patterns/three-tier-web.ts:69-72`
**Boundary**: semantic drift between description string and actual config.

The GroupDescription says "Application tier ingress from the ALB",
suggesting a rule. No `SecurityGroupIngress` is set. Apply succeeds
(CCAPI doesn't require rules) but the pattern is non-functional.
Nightly "apply succeeds" ≠ "traffic flows". Flagged per instructions.

---

## LOW

### L1. `ALTERNATE_TAG_KEY_TYPES` assumes exactly one alt-key type per resourceType

**File**: `apps/cli/src/utils/tags.ts:49-51`

Current Map<string,string> shape allows one alt key. Fine today. If a
future type needs both `Tags` AND `FileSystemTags` (e.g. a hybrid
resource), the model breaks. Non-actionable, just noted.

### L2. `Array.from(tagMap.entries())` key order reliance

**File**: `apps/cli/src/utils/tags.ts:155-158`

Iteration order of Map preserves insertion. `existingFromStandard`
before `existingFromAlternate`, then mandatory after. Tests that
snapshot the full merged Tags array by index will be brittle if the
alternate key becomes populated. Non-blocking.

### L3. Precedence: mandatory tags overwrite user-typed Name tag

**File**: `apps/cli/src/utils/tags.ts:158`

If a user types `FileSystemName` as "managed-by" (unlikely but
possible for a user testing tag collisions), their value is silently
replaced by `AssigneeTag.VALUE`. Acceptable — mandatory tags are
documented to override — but no log entry warns the user.

---

## Summary

- **Ship-blockers (C1, C2)**: three-tier-web pattern still won't apply
  end-to-end — the fix only cleared the first of at least three
  required-field failures.
- **Silent data loss (C3, C4)**: EFS user-input is dropped in both
  compound and wizard paths.
- **Latent time-bomb (H1, H2)**: mixed-provisionability compounds and
  result-formatter code ordering are not defended by assertions/tests.
- **Test drift (H3)**: regression test no longer pins its stated
  invariant.
- **Future-proofing (H4, M1–M4, L1–L3)**: defensive cleanup.
