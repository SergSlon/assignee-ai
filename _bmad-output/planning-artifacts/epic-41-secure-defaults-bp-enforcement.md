# Epic 41 — Secure by Default + BP Enforcement Across All Flows

## Problem Statement

Two systemic issues undermine the security posture of provisioned resources:

### 1. Insecure Wizard Defaults

Users who accept all defaults create resources that **fail their own BP rules**. The wizard proposes insecure options, then BP rules block the apply — frustrating UX that trains users to bypass checks.

| Resource  | Insecure Default            | Secure Default               | BP Rule              |
| --------- | --------------------------- | ---------------------------- | -------------------- |
| S3 Bucket | Encryption: `false`         | `true` (SSE-S3)              | BP-S3-006 (blocking) |
| S3 Bucket | PublicAccessBlock: `true`   | `true`                       | BP-S3-001 (blocking) |
| S3 Bucket | Versioning: `false`         | `true`                       | BP-S3-004 (blocking) |
| RDS       | DeletionProtection: `false` | `true`                       | BP-RDS-010           |
| RDS       | MultiAZ: `false`            | `true`                       | BP-RDS-006           |
| RDS       | BackupRetention: unset      | `7` days                     | BP-RDS-004           |
| DynamoDB  | DeletionProtection: `false` | `true`                       | BP-DDB-004           |
| SQS       | Encryption: unset           | `SqsManagedSseEnabled: true` | BP-SQS-001           |
| SNS       | Encryption: unset           | `alias/aws/sns`              | BP-SNS-001           |
| Logs      | KmsKeyId: unset             | prompt with recommendation   | BP-CWL-002           |

### 2. BP Enforcement Gaps

BP rules evaluate but don't enforce in several flows:

| Flow                 |       BP Evaluated       |     Blocking Enforced      | Gap                                      |
| -------------------- | :----------------------: | :------------------------: | ---------------------------------------- |
| `apply`              |           Yes            |            Yes             | None                                     |
| `apply --yes`        |           Yes            | **No** — bypassed silently | CI/CD creates insecure resources         |
| `apply --no-wizard`  |           Yes            | **No** — bypassed silently | Non-interactive mode ignores blocking    |
| `apply --checkpoint` | **No** — Phase 1 skipped |           **No**           | Checkpoint resume has zero BP protection |
| MCP `apply_plan`     | **No** — Phase 1 skipped |           **No**           | AI agents provision without BP checks    |

### 3. Missing BP Rules

Two supported resource types have zero best-practice rules:

- **AWS::ECS::Cluster** — no rules for Container Insights, logging, capacity
- **AWS::EC2::RouteTable** — delegated to Route rules (acceptable)

## Success Criteria

- All wizard defaults produce resources that pass ALL blocking BP rules without user changes
- BP rules evaluate and enforce in ALL flows (plan, apply, --yes, --no-wizard, checkpoint, MCP)
- User configures enforcement level at init: `enforce` (default), `warn`, `skip`
- Company can override via org policy in SaaS (enforce always)
- All 23 resource types have at least 1 BP rule
- All tests cover every status × mode × flag combination

---

## Stories

### Story 41.1 — Secure Wizard Defaults (P0)

**Files:** All plugin files in `packages/core/src/resource-plugins/plugins/`

Flip ALL wizard defaults to the secure option:

| Plugin            | Field                            | Change                                                                   |
| ----------------- | -------------------------------- | ------------------------------------------------------------------------ |
| s3-bucket.ts      | `BucketEncryption`               | `initialValue: true` (already correct)                                   |
| s3-bucket.ts      | `PublicAccessBlockConfiguration` | `initialValue: true` (already correct)                                   |
| s3-bucket.ts      | `VersioningConfiguration`        | `initialValue: false` → **`true`**                                       |
| rds-dbinstance.ts | `DeletionProtection`             | `initialValue: false` → **`true`**                                       |
| rds-dbinstance.ts | `MultiAZ`                        | `initialValue: false` → **`true`**                                       |
| rds-dbinstance.ts | `BackupRetentionPeriod`          | Add `initialValue: "7"`                                                  |
| dynamodb-table.ts | `DeletionProtectionEnabled`      | `initialValue: false` → **`true`**                                       |
| sqs-queue.ts      | Encryption                       | Add `defaults: { SqsManagedSseEnabled: true }` to toCfn                  |
| sns-topic.ts      | Encryption                       | Add `defaults: { KmsMasterKeyId: "alias/aws/sns" }` or SQS-style managed |
| logs-loggroup.ts  | `RetentionInDays`                | `initialValue: "14"` → **`"30"`**                                        |

**Principle:** Accept-all-defaults must produce a resource that passes every blocking BP rule.

**Test:** For each plugin, call toCfn with all defaults accepted → run BP evaluator → assert zero blocking findings.

**AC:**

- Every plugin's default output passes all blocking BP rules
- User can still opt out of any secure default (the wizard asks, just defaults to secure)
- Tests verify default→BP→zero-blocking for all 23 types

---

### Story 41.2 — BP Enforcement Levels (P0)

**Files:**

- `packages/core/src/schema/graph-state.ts` — add `bpEnforcementLevel` to state
- `apps/cli/src/nodes/preflight-guard.ts` — respect enforcement level
- `apps/cli/src/config/user-config-loader.ts` — load from config
- `apps/cli/src/config/org-policy-cache.ts` — org override

Add enforcement level to `.assignee/config.yaml`:

```yaml
bestPractices:
  enforcement: enforce # enforce | warn | skip
  autoFix: true
```

In preflight-guard.ts, replace the binary bypass logic:

```typescript
// CURRENT (line 69):
if (blockingFindings.length > 0 && !state.noWizard && !state.autoApprove) {

// NEW:
const level = state.bpEnforcementLevel ?? "enforce";
if (level === "skip") {
  // No blocking, no logging (user explicitly opted out)
} else if (level === "warn") {
  // Log warning, set preflightPassed = true (advisory)
} else {
  // "enforce" (default): block regardless of --yes or --no-wizard
  if (blockingFindings.length > 0) bpBlocked = true;
}
```

**Key change:** `--yes` and `--no-wizard` no longer bypass BP blocking. The ONLY way to bypass is explicit `enforcement: warn` or `enforcement: skip` in config.

**Org policy override:** If org policy sets `enforcement: enforce`, user cannot downgrade to `warn` or `skip`.

**AC:**

- Default enforcement is `enforce` — blocking BPs block ALL flows including --yes
- `warn` mode: BPs evaluate, findings shown as warnings, apply proceeds
- `skip` mode: BPs don't evaluate (developer explicitly opted out)
- Org policy `enforce` overrides user `warn`/`skip`
- Existing `autoFixBestPractices` still works (auto-fix before enforcement check)

---

### Story 41.3 — BP Re-evaluation on Checkpoint Resume (P0)

**Files:**

- `apps/cli/src/services/graph-routing.ts` — change checkpoint entry routing
- `apps/cli/src/commands/apply.ts` — inject BP re-evaluation
- `apps/cli/src/services/checkpoint.ts` — persist bpFindings in checkpoint

Currently checkpoint resume skips Phase 1 entirely (graph-routing.ts line 25). Change to:

Option A (preferred): **Re-evaluate BPs on resume**

- Checkpoint resume still skips intent_parser → schema_fetcher → option_elicitor
- But MUST run: plan_generator (re-generate from saved desiredState) → bp_evaluator → fix_applicator → preflight_guard
- This catches: changed BP rules, edited checkpoint JSON, new security requirements

Option B: **Persist and re-check findings**

- Save bpFindings in checkpoint (currently NOT saved)
- On resume, verify saved findings still match current BP rules
- If mismatch, re-evaluate

**AC:**

- Checkpoint resume runs BP evaluation (not just reuses old preflightPassed)
- If BP rules changed since plan was saved, new blocking findings surface
- If user edited checkpoint desiredState, BPs re-evaluate against new state

---

### Story 41.4 — MCP apply_plan BP Enforcement (P0)

**Files:**

- `apps/mcp-server/src/tools/apply-plan.ts` — add BP re-evaluation
- `apps/mcp-server/src/tools/plan-resource.ts` — persist findings in response

Currently MCP `apply_plan` sets `checkpointResumed: true` + `autoApprove: true`, bypassing all BP checks.

Fix:

1. `plan_resource` returns bpFindings in response (already does, line 155)
2. `apply_plan` re-runs BP evaluation against the checkpoint's desiredState before provisioning
3. If blocking findings exist AND enforcement is `enforce`, return error with findings
4. The `confirmed: true` gate remains but is supplementary to BP enforcement

**AC:**

- MCP apply_plan evaluates BPs before provisioning
- Blocking findings in enforce mode prevent provisioning (return error with findings list)
- Client sees exact findings and can fix desiredState before retrying
- `confirmed: true` is still required (defense in depth)

---

### Story 41.5 — ECS Cluster BP Rules (P1)

**File:** `packages/best-practices/src/rules/ecs/`

Add rules for ECS::Cluster:

- BP-ECS-001: Container Insights should be enabled (blocking) — `ClusterSettings` should include `containerInsights: enabled`
- BP-ECS-002: Execute command logging recommended — `Configuration.ExecuteCommandConfiguration.Logging` should be set
- BP-ECS-003: Capacity providers should be defined — at least one capacity provider association

**AC:**

- 3 new BP rules for ECS::Cluster
- BP-ECS-001 is blocking (Container Insights is a security/observability requirement)
- Tests for all rules
- ECS Cluster plugin defaults produce zero blocking findings

---

### Story 41.6 — Default-to-BP Alignment Tests (P0)

**File:** New test `packages/core/src/resource-plugins/__tests__/secure-defaults-audit.test.ts`

For EVERY resource type that has both a plugin AND BP rules:

1. Generate desiredState by accepting ALL wizard defaults
2. Run BP evaluator against that desiredState
3. Assert: ZERO blocking findings

This is the **golden test** — if a wizard default is insecure and a BP rule catches it, this test fails. It catches:

- New BP rules that conflict with existing defaults
- Default changes that regress security
- New resource types missing secure defaults

```typescript
for (const resourceType of SUPPORTED_TYPES_ARRAY) {
  it(`${resourceType}: all defaults pass blocking BPs`, () => {
    const plugin = defaultPluginRegistry.get(resourceType);
    const defaults = generateDefaults(plugin); // accept all initialValues
    const findings = evaluateBP(resourceType, defaults);
    const blocking = findings.filter((f) => f.blocking);
    expect(blocking).toHaveLength(0);
  });
}
```

**AC:**

- Test covers all 23 resource types
- Any insecure default + blocking BP combination fails the test
- Runs in CI — catches regressions immediately

---

### Story 41.7 — Flow × Status Integration Tests (P1)

**File:** New test `apps/cli/src/__tests__/bp-enforcement-flows.test.ts`

Test matrix — every flow × enforcement combination:

| Test | Flow                   | Enforcement | Has Blocking BPs  | Expected                          |
| ---- | ---------------------- | ----------- | :---------------: | --------------------------------- |
| 1    | apply                  | enforce     |        Yes        | BLOCKED — plan box shown          |
| 2    | apply                  | enforce     |        No         | APPROVED — provisions             |
| 3    | apply --yes            | enforce     |        Yes        | BLOCKED (not bypassed!)           |
| 4    | apply --yes            | warn        |        Yes        | WARNING shown, provisions         |
| 5    | apply --yes            | skip        |        Yes        | No evaluation, provisions         |
| 6    | apply --no-wizard      | enforce     |        Yes        | BLOCKED                           |
| 7    | apply --checkpoint     | enforce     |   Yes (re-eval)   | BLOCKED                           |
| 8    | MCP apply_plan         | enforce     |   Yes (re-eval)   | ERROR returned                    |
| 9    | Compound (3 resources) | enforce     | Yes on resource 2 | Resource 1 OK, resource 2 BLOCKED |

**AC:**

- All 9 scenarios tested
- Tests verify user-facing output (renderPlanBox, renderError, renderApplySuccess)
- Tests verify enforcement level is respected in every flow

---

## Implementation Order

1. **Story 41.1** (Secure defaults) + **Story 41.6** (Golden test) — do together, test validates
2. **Story 41.2** (Enforcement levels) — core behavioral change
3. **Story 41.3** (Checkpoint re-eval) + **Story 41.4** (MCP re-eval) — parallel
4. **Story 41.5** (ECS rules) — independent
5. **Story 41.7** (Flow integration tests) — validates everything

## Risks

- **Breaking change:** `--yes` will no longer bypass BP blocking. CI/CD pipelines that relied on bypass will fail. Mitigation: add `bestPractices.enforcement: warn` to config for backward compat.
- **Checkpoint re-evaluation adds latency:** BP eval is <1ms (synchronous), but plan_generator LLM call could add 1-2s. Mitigation: skip plan_generator, re-evaluate BPs directly against saved desiredState.
- **Org policy enforcement requires SaaS:** For now, local org policy file works. SaaS enforcement is future.

## Architecture Notes

- Enforcement level flows: CLI config → merged with org policy → injected into graph state as `bpEnforcementLevel`
- Org policy wins on collision: if org says `enforce`, user config `warn` is overridden
- `autoFixBestPractices` runs BEFORE enforcement check — auto-fixed findings don't block
- The `confirmed` gate in MCP apply_plan remains as defense-in-depth (separate from BP enforcement)
