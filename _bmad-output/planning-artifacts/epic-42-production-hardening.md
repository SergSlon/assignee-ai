# Epic 42 — Production Hardening: Bugs, SOLID Refactoring, and Validation Gaps

## Problem Statement

The production readiness audit found 1 P0 bug, 5 P1 bugs, 4 stuck BP rules, input validation gaps, and SOLID violations. These must be fixed before release.

## Stories

### Story 42.1 — P0: EIP Leak on NAT Gateway Retry (CRITICAL)

**File:** `apps/cli/src/nodes/resource-provisioner.ts` (lines 230-263)

When EIP allocation succeeds but provisioning fails, retrying allocates a SECOND EIP without releasing the first. Each orphaned EIP costs $3.60/month.

**Fix:** Before allocating, query existing EIPs tagged with `assignee:runId` to detect prior allocations. If found, reuse instead of allocating new.

**Test:** Mock EIP allocation, simulate failure after allocation, verify retry reuses existing EIP.

---

### Story 42.2 — P1 Bug Fixes (5 bugs)

**42.2a — Checkpoint atomic write** (`apps/cli/src/services/checkpoint.ts`)
Replace `writeFile` with atomic write pattern: write to `.tmp.{pid}`, then `rename`.

**42.2b — Null pointer in plan-generator field dependencies** (`apps/cli/src/nodes/plan-generator.ts:614`)
Change `state.elicitedOptions![depField]` to `state.elicitedOptions?.[depField]`.

**42.2c — Compound progress display hiding errors** (`apps/cli/src/utils/command-runner.ts:212`)
Add bounds check: `if (resourcesProvisioned >= (phase1State.resourceQueue?.length ?? 0))` break with error.

**42.2d — Silent CI approval audit gap** (`apps/cli/src/nodes/human-approval.ts`)
Add explicit `non-tty + no autoApprove` check BEFORE any approval logic. Log approval source (interactive/autoApprove/checkpoint) for audit trail.

**42.2e — Partial compound success masked** (`apps/cli/src/nodes/result-formatter.ts:376-401`)
Replace silent partial-success handler with explicit FAILED status + error message when nextResource is undefined.

---

### Story 42.3 — Fix 4 Stuck BP Rules

4 rules are blocking but have NO fix mechanism (auto or interactive). Users get stuck.

| Rule                          | Fix                                                       |
| ----------------------------- | --------------------------------------------------------- |
| BP-APIGW-001 (access logging) | Change to `blocking: false` — cross-resource dependency   |
| BP-APIGW-002 (CORS wildcard)  | Add interactive option: prompt for specific origins       |
| BP-CW-001 (alarm actions)     | Change to `blocking: false` — requires external SNS ARN   |
| BP-IAM-005 (wildcard actions) | Add interactive option: suggest scoped actions by service |

**Principle:** If a rule can't be auto-fixed or interactively fixed, it must NOT be blocking.

**Test:** Add to bp-auto-fix-audit.test.ts: verify every blocking rule has either desiredStatePatch or interactiveOptions.

---

### Story 42.4 — Compound Pattern Security Gaps

**42.4a — static-website pattern** (`packages/core/src/pattern-templates/patterns/static-website.ts`)

- Add `BucketEncryption` with SSE-S3 to S3 bucket config
- Add `VersioningConfiguration: { Status: "Enabled" }`
- Note: PublicAccessBlock must remain disabled for public website (by design)

**42.4b — serverless-api CORS wildcard** (`packages/core/src/pattern-templates/patterns/serverless-api.ts`)

- Change `CorsAllowOrigins: ["*"]` to empty array with a comment explaining user must set specific origins
- Or make origins a template parameter that patterns can pass through

---

### Story 42.5 — MCP Server Use RESOURCE_TYPES Constants

**Files:**

- `apps/mcp-server/src/services/free-tier.ts` — replace all raw `"AWS::*"` strings with `RESOURCE_TYPES.*`
- `apps/mcp-server/src/services/cost-estimator.ts` — replace `resourceType: "AWS::*"` with `RESOURCE_TYPES.*`
- `apps/mcp-server/src/tools/destroy-resource.ts` — replace raw type strings in SERVICE_TYPE_MAP, ARN_IDENTIFIER_TYPES

Import `RESOURCE_TYPES` from `@assignee/core` (already a dependency).

**Test:** Existing tests should still pass — behavior unchanged, just constants.

---

### Story 42.6 — Input Validation Hardening (Top 5)

**42.6a — SQS/SNS FIFO naming** (`sqs-queue.ts`, `sns-topic.ts`)
Add validation: if FifoQueue/FifoTopic is true, strip `.fifo` suffix from name if user included it.

**42.6b — Security Group port validation** (`security-group.ts`)
Strengthen `parseRuleString()`: validate port range 1-65535, from <= to, warn on 0.0.0.0/0 + SSH.

**42.6c — IAM PermissionsBoundary enforcement** (`iam-role.ts`)
Add `required: true` to PermissionsBoundary field when enforcement level is "enforce". Add validation blocking `AdministratorAccess` in ManagedPolicyArns.

**42.6d — NAT Gateway subnet validation** (`ec2-nat-gateway.ts`)
Add hint/validation that selected subnet should be public (has route to IGW).

**42.6e — ELB subnet AZ diversity** (`elbv2-loadbalancer.ts`)
Add validation requiring subnets in at least 2 different AZs.

---

### Story 42.7 — SOLID: Split result-formatter.ts (759 lines → 3 modules)

Extract from `apps/cli/src/nodes/result-formatter.ts`:

1. **`utils/security-posture.ts`** — `checkSecurityPosture()`, security finding rendering
2. **`utils/memory-recorder.ts`** — `writeProvisionRecord()`, `writeFailureRecord()`, memory hint logic
3. **`nodes/result-formatter.ts`** — thin orchestrator calling the above modules

Each module gets its own test file. The result-formatter.ts should be under 200 lines.

---

### Story 42.8 — SOLID: Destroy Strategy Registry

Replace hard-coded type checks in destroy flow with pluggable strategy pattern:

**File:** `apps/mcp-server/src/tools/destroy-resource.ts`

```typescript
interface DestroyStrategy {
  resourceType: string;
  usesArnIdentifier: boolean;
  isSlow: boolean;
  preDestroy?(arn: string, client: CloudControlClient): Promise<void>;
  extractIdentifier?(arn: string): string;
}

class DestroyStrategyRegistry {
  register(strategy: DestroyStrategy): void;
  get(resourceType: string): DestroyStrategy | undefined;
}
```

Move all type-specific logic (IGW detach, SQS URL construction, CloudFront disable) into individual strategy files.

---

### Story 42.9 — Eliminate Magic Strings: CloudFormation Property Keys (LARGE)

The codebase has **hundreds of raw CloudFormation property names** used as strings in plugins, toCfn transforms, plan-generator, and desiredState access. Currently only 2 keys are in `cfn-keys.ts` and 7 in `resource-fields.ts`.

**Phase 1: Expand `constants/cfn-keys.ts`** with service-scoped constants:

```typescript
export const CfnKey = {
  // S3
  BUCKET_NAME: "BucketName",
  BUCKET_ENCRYPTION: "BucketEncryption",
  VERSIONING_CONFIGURATION: "VersioningConfiguration",
  PUBLIC_ACCESS_BLOCK: "PublicAccessBlockConfiguration",
  LIFECYCLE_CONFIGURATION: "LifecycleConfiguration",
  CORS_CONFIGURATION: "CorsConfiguration",
  // EC2
  INSTANCE_TYPE: "InstanceType",
  IMAGE_ID: "ImageId",
  BLOCK_DEVICE_MAPPINGS: "BlockDeviceMappings",
  ASSOCIATE_PUBLIC_IP: "AssociatePublicIpAddress",
  METADATA_OPTIONS: "MetadataOptions",
  // RDS
  DB_INSTANCE_CLASS: "DBInstanceClass",
  ENGINE: "Engine",
  STORAGE_ENCRYPTED: "StorageEncrypted",
  DELETION_PROTECTION: "DeletionProtection",
  MULTI_AZ: "MultiAZ",
  // ... ALL property keys used in plugins
} as const;
```

**Phase 2: Replace raw strings in ALL plugin files:**

- Every `transformed["BucketEncryption"]` → `transformed[CfnKey.BUCKET_ENCRYPTION]`
- Every `desiredState["InstanceType"]` → `desiredState[CfnKey.INSTANCE_TYPE]`
- Every `name: "BucketName"` field definition → `name: CfnKey.BUCKET_NAME`

**Phase 3: Replace in non-plugin code:**

- plan-generator.ts (field references)
- pricing decomposers (desiredState access)
- bp-evaluator (property_path references)
- result-formatter (display logic)

**Scope:** ~500 replacements across ~40 files. Use `replace_all` where possible.

**Test:** All existing tests must pass — behavior unchanged, only string references centralized.

---

### Story 42.10 — Centralize Infrastructure Constants

- Move all `"us-east-1"` fallbacks to use `AWS_REGION` from `config/constants.ts`
- Move `POLL_INTERVAL_MS` (defined twice in destroy-service + destroy-resource) to `config/constants.ts`
- Move `MAX_POLL_ATTEMPTS` (defined twice) to `config/constants.ts`
- Extract Lambda memory thresholds (128/256/512) in wizard-recommendations.ts to named constants
- Consolidate `EXTENDED_TIMEOUT_MS` in pricing decomposers (defined in ec2.ts and rds.ts separately)

---

## Implementation Order

**Phase 1 (P0 + P1 bugs):** Stories 42.1, 42.2 — parallel subagents, 3 max
**Phase 2 (BP + patterns):** Stories 42.3, 42.4 — parallel
**Phase 3 (Constants + validation):** Stories 42.5, 42.6, 42.10 — parallel
**Phase 4 (Magic strings):** Story 42.9 — large, needs dedicated focus
**Phase 5 (SOLID refactoring):** Stories 42.7, 42.8 — parallel
**Phase 6:** BMAD quality loop (code-review + adversarial + edge-case)
**Phase 7:** Final build + test + commit

## Estimated Complexity

- Stories 42.1, 42.2: Medium (bug fixes with tests)
- Stories 42.3, 42.4: Small (YAML edits + pattern config)
- Stories 42.5, 42.10: Small (find-replace with constants)
- Story 42.6: Medium (validation logic + tests)
- **Story 42.9: LARGE** (~500 replacements across ~40 files, must not break anything)
- Stories 42.7, 42.8: Large (refactoring, tests, many file moves)

## Risks

- **Story 42.9** is the biggest — touching 40+ files with string replacements. Must run full test suite after each batch.
- **Story 42.7 refactoring** may break import chains — need careful dependency management
- **Story 42.8** changes destroy flow — comprehensive testing needed since it touches real AWS resources
- **Story 42.6c** (IAM PermissionsBoundary required) may break existing users without boundaries — needs config escape hatch
