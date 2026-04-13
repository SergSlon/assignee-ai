# Blind Hunter Review — 6-file bug-fix diff (2026-04-11)

Scope: plan-generator.ts, result-formatter.ts, tags.ts, three-tier-web.ts, efs-file-system.ts, efs-file-system.test.ts. `pnpm build` clean. Tags + result-formatter + compound-provisioning-audit suites green.

---

## HIGH — result-formatter.ts single-resource ARN propagation contradicts pinned regression invariant

**File**: `apps/cli/src/nodes/result-formatter.ts:482-484`

**Observed**: New branch `if (displayArn && displayArn !== state.resourceArn) return { resourceArn: displayArn }`. The return value is a LangGraph partial state update — the graph reducer merges it into final `state.resourceArn`, overwriting the bare CCAPI identifier with the full ARN.

**Expected**: The regression test at `result-formatter.test.ts:224` (Adversarial Hunter v6 P0) documents the invariant "result-formatter must NEVER mutate state.resourceArn." The test only catches in-place mutation via `Object.assign`; it does NOT catch a partial-state-update return. The new code violates the documented invariant without the author recognizing it — the comment handwaves "terminal node so the compound marker resolver never re-reads state.resourceArn." That is true for the in-process graph run, but:

1. Any post-graph consumer that reads `state.resourceArn` (apply stdout capture, telemetry exporter, memory/provision-record writers that run AFTER the graph closes, and `apps/cli/src/commands/apply.ts` which inspects `phase1State` on line 513/600) now sees a full ARN where it previously saw a bare identifier. The commit comment explicitly lists "e2e tests, API consumers, apply success stdout capture" as affected — but that's a silent contract change, not a fix.
2. The S3 upload branch 12 lines above (line 404-438) handles the bare-vs-ARN ambiguity itself. It runs BEFORE the new mutation, so it's unaffected — but any future single-resource post-success hook that relies on the bare identifier will silently break.
3. The pinned regression test passes only because it constructs a fresh `state` object and asserts against the caller's reference, which the partial-state return leaves untouched. The invariant the test is trying to protect is actually violated.

**Evidence**: `graph-routing.test.ts:230` confirms single-resource → END, but `apps/cli/src/commands/apply.ts:513,600` reads `phase1State.executionStatus` and downstream fields — the final merged state now has a full-ARN `resourceArn`, and the SSM param destroy path (the bug being fixed) may be the ONLY caller that needed that transformation.

**Fix direction**: Instead of mutating graph state, add a dedicated `resolvedResourceArn` field to the graph state schema and propagate that separately, OR do the ARN resolution once at the start of result-formatter and store it in a local variable only — never return it. If the SSM destroy flow needs the full ARN, surface it through a new state field, not by overloading `resourceArn`.

---

## MEDIUM — plan-generator.ts non-provisionable branch silently replaces real dependency markers with display strings in APPLY mode

**File**: `apps/cli/src/nodes/plan-generator.ts:808-814`

**Observed**: In APPLY mode, when `currentResource.provisionable === false`, the code calls `resolvePlaceholderMarkers` which substitutes every `__ASSIGNEE_REF_*__` / `__ASSIGNEE_GETATT_*__` token with the literal human string `"(from <resourceId>)"` (see line 519 of the same file).

**Expected**: The author's argument is that non-provisionable resources never go through CCAPI, so garbage values are harmless. That is TRUE for the CCAPI provisioner, but the resulting `desiredState` still flows into:

- `writeProvisionRecord` (the desiredState snapshot is written verbatim to disk per NFR-14 traceability)
- `renderApplySuccess` / compound render (displayed to user)
- Cost estimation / pricing decomposer
- Memory pattern snapshots

All of these will record/display `"(from http-api)"` instead of the resolved ARN. For serverless-api's LAMBDA_INTEGRATION resource whose `ApiId` field references HTTP_API, the provision record now stores `ApiId: "(from http-api)"`. Any downstream reconciliation, drift check, or support bundle will be corrupted.

A cleaner fix: when `provisionable === false` AND the dependency IS provisionable, `resolveCompoundMarkers` should still attempt resolution against `completedResources`. Only when BOTH current + dependency are non-provisionable (as the serverless-api LAMBDA_INTEGRATION → HTTP_API case) should we fall back to placeholders. The current branch over-applies.

**Fix direction**: Try `resolveCompoundMarkers` first for non-provisionable companions; if it throws the `completed without a physical identifier` error specifically, fall back to `resolvePlaceholderMarkers`. Never silently use placeholders in APPLY mode when real resolution is possible.

---

## MEDIUM — three-tier-web.ts Security Groups have no ingress/egress rules and no VpcId — resulting stack is non-functional

**File**: `packages/core/src/pattern-templates/patterns/three-tier-web.ts:65-72`

**Observed**: The new `defaultOptions` only supplies `GroupDescription`. The ALB_SG has no ingress allowing 0.0.0.0/0:443; the APP_SG has no ingress from the ALB_SG; neither has egress rules. `VpcId` is omitted, relying on default VPC.

**Expected**: Three-tier-web should actually work end-to-end. As shipped, the pattern will apply cleanly (CCAPI accepts a descriptionless/ruleless SG with an implicit allow-all egress) but the ALB will have no listener targets reachable, the EC2 instance will not accept ALB traffic, and RDS won't accept the EC2 instance. The comment says "compound provisioner reaches the ingress/egress rules" — but they were never added to the pattern. This is a fresh landmine disguised as a fix: users will run `apply`, see SUCCESS, and hit unreachable services.

Also note the pattern does not include an RDS SG at all — RDS_INSTANCE has no SG reference in `defaultOptions`, so it too defaults to account-default SG, which usually blocks inbound.

**Fix direction**: Add `SecurityGroupIngress` / `SecurityGroupEgress` arrays to both SGs + an RDS SG (or mount the DB inside APP_SG) + an explicit `VpcId` marker referencing the default VPC resolver, before this pattern ships.

---

## LOW — efs-file-system.ts renamed field leaks generic "Tags" wizard question

**File**: `packages/core/src/resource-plugins/plugins/efs-file-system.ts:135-154`

**Observed**: The plugin now has TWO fields that target EFS tag properties:

1. The renamed `FILE_SYSTEM_TAGS` field (line 46) whose `toCfn` emits `[{Key:"Name", Value}]` at the `FileSystemTags` key.
2. The legacy `CfnKey.TAGS` "Tags" field (line 135) whose `toCfn` emits `[{Key, Value}, ...]` at the `Tags` key.

After the wizard runs, a standalone `assignee apply` on EFS will produce a desiredState containing BOTH `FileSystemTags: [...]` AND `Tags: [...]`. The tags.ts `injectMandatoryTags` cleanup merges them correctly for the apply step — but anything upstream of tag injection that inspects the raw desiredState (plan preview, display formatter, pricing-estimator, cost hints) sees a `Tags` property that the plugin's own configHints (line 248) explicitly forbid: "Do NOT emit a top-level Tags property."

Additionally, the compound path (`efs-with-vpc`) never runs the field wizard, so `FileSystemTags` required-injection at compound level is a no-op because `plugin.defaults` doesn't contain a `FileSystemTags` entry — the "required: true" marker is enforcement theater in compound mode.

**Fix direction**: Either delete the generic TAGS field entirely for EFS and rely solely on `injectMandatoryTags` + a future "extra tags" question that also writes to `FileSystemTags`, OR make the TAGS field's `toCfn` emit under `FileSystemTags` directly. Also add a `plugin.defaults[FileSystemTags] = [{Key:"Name", Value:"assignee-efs"}]` so the compound required-field enforcement has something to inject.

---

## LOW — tags.ts ALTERNATE_TAG_KEY_TYPES ignores the FLAT_MAP path

**File**: `apps/cli/src/utils/tags.ts:114-126`

**Observed**: The FLAT_MAP_TAG_TYPES branch (SSM Parameter) runs before the alternate-key logic and unconditionally writes to `CfnKey.TAGS`. If any future FLAT_MAP type also happens to need a non-standard key, this code silently skips the alternate-key handling. Not a bug today (SSM uses `Tags`), but the `ALTERNATE_TAG_KEY_TYPES` abstraction doesn't compose with FLAT_MAP, and there is no comment warning the next author. Note also that the early `NO_TAG_TYPES` short-circuit on line 104 returns `{ ...desiredState }` WITHOUT stripping a stray `Tags` key — if a NO_TAG_TYPES resource also happens to have been added to `ALTERNATE_TAG_KEY_TYPES`, nothing strips the stray key.

**Fix direction**: Move the alternate-key resolution to the top of the function and short-circuit both FLAT_MAP and NO_TAG_TYPES paths to also honor it (or assert they are mutually exclusive).

---

## Verified clean

- `CfnKey.NAME` grep across entire repo — no external caller references EFS's old `NAME` field. Only `elbv2-loadbalancer`, `secretsmanager-secret`, `ssm-parameter`, `apigatewayv2-api` still use it, and those plugins legitimately have top-level Name properties.
- `CfnKey.FILE_SYSTEM_TAGS = "FileSystemTags"` at `packages/core/src/config/cfn-keys.ts:239` — resolves correctly.
- `CfnKey.GROUP_DESCRIPTION = "GroupDescription"` at `cfn-keys.ts:156` — matches the security-group plugin's `commonFields[0]`.
- `resolveCompoundMarkers` has no callers outside `plan-generator.ts` proper — no sibling that needs the same `provisionable:false` patch.
- `injectMandatoryTags` merge logic for EFS: mandatory tags correctly OVERWRITE duplicate Keys (tagMap set order); existing-from-standard and existing-from-alternate both preserved pre-dedup.
- `pnpm build` — clean (77ms, full turbo cache hit on CLI).
- Targeted tests (`tags.test.ts` 8/8, `result-formatter.test.ts` 55/55, `compound-provisioning-audit.test.ts` 85/85) all pass.

---

**Summary**: 1 HIGH (result-formatter silently breaks its own pinned invariant despite passing the test), 2 MEDIUM (plan-generator over-applies placeholder fallback, three-tier-web ships non-functional SGs), 2 LOW (EFS dual-Tags field, tags.ts composition gaps). None block the nightly fix but all should be addressed before merge.
