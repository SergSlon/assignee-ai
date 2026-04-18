# Testing Guide — Assignee.ai CLI-First MVP

> Unit tests (Vitest), MCP server E2E tests against real AWS, and end-to-end smoke tests for the CLI commands.

---

## Quick reference

```bash
pnpm test                                    # ~7595 tests across 303 files, ~20s, no AWS needed
pnpm check-types                             # TypeScript type check
pnpm --filter @assignee/mcp-server test:e2e  # MCP E2E against real AWS (~43 min)
RUN_E2E=1 pnpm --filter assignee test        # CLI graph E2E against real AWS (opt-in gate)
```

---

## CLI E2E gate — `RUN_E2E=1` and turbo cache keys

The CLI graph E2E suite (`apps/cli/src/e2e/e2e-plan.test.ts`) hits real AWS via the
full LangGraph pipeline with real MCP servers and operator credentials. It is
**opt-in only**. The gate is implemented at lines 27-28 of the file:

```ts
const RUN_E2E = process.env["RUN_E2E"] === "1";
const describeE2E = RUN_E2E ? describe : describe.skip;
```

Plain `pnpm test` (and any CI job without `RUN_E2E=1`) will always skip the
31 E2E cases — no real provisioning happens. To opt in:

```bash
# Make sure .env contains ASSIGNEE_OPERATOR_ACCESS_KEY_ID / SECRET and AWS_REGION
RUN_E2E=1 pnpm --filter assignee test
# or for just the e2e file (recommended — faster feedback):
RUN_E2E=1 npx vitest run src/e2e/e2e-plan.test.ts --reporter=verbose
```

### Why the gate needs turbo env passthrough (don't remove this!)

Turbo caches task results by a hash of inputs + env vars. **Env vars that flip
test behavior MUST be declared in the task's `env` array in `turbo.json`**, or
turbo will silently replay the old cached result even when you set the var.

Historically, `RUN_E2E` was **not** declared — which meant `RUN_E2E=1 pnpm test`
would return from turbo cache in ~40ms with the old "skipped" result still in
place. Developers who explicitly opted in got a lie. The gate was effectively
broken for anyone relying on `pnpm test` / `pnpm turbo run test`.

Fix: `turbo.json` declares the full set of test-affecting env vars under
`tasks.test.env` and `tasks.test:coverage.env`:

- `RUN_E2E` — CLI E2E suite gate (this file)
- `CI` — `skipIf(!!process.env["CI"])` in `mcp-client.test.ts`
- `NODE_ENV` — BP evaluator default mode (`bp-evaluator.test.ts`)
- `ASSIGNEE_BP_INTEGRITY` — BP enforcement mode (`bp-evaluator.test.ts`)
- `ASSIGNEE_LOG_LEVEL`, `ASSIGNEE_VERBOSITY` — logger output
- `ASSIGNEE_OPERATOR_*`, `ASSIGNEE_READER_*`, `ASSIGNEE_AUDITOR_*` —
  presence/absence flips `skipIfNoCreds()` in E2E tests
- `AWS_REGION`, `AWS_DEFAULT_REGION` — region selection inside E2E tests

Each of these is part of the turbo cache key. Change any one of them and
turbo will miss the cache and re-run the tests.

### How to verify cache invalidation works

If you suspect the gate is being bypassed by cache replay, compare task hashes:

```bash
# Without RUN_E2E — baseline hash
pnpm turbo run test --filter=assignee --dry=json | jq -r '.tasks[].hash'

# With RUN_E2E=1 — MUST be a different hash
RUN_E2E=1 pnpm turbo run test --filter=assignee --dry=json | jq -r '.tasks[].hash'
```

If the two hashes are identical, `RUN_E2E` is missing from the task `env`
array in `turbo.json`. Fix that, don't work around it.

End-to-end check (cache hit/miss timings):

```bash
pnpm test --force                    # cache bypass, runs everything
pnpm test                            # FULL TURBO cache hit, <50ms per task
RUN_E2E=1 pnpm test                  # cache MISS, re-runs (different env hash)
RUN_E2E=1 pnpm test                  # FULL TURBO cache hit with E2E path cached
pnpm test                            # FULL TURBO cache hit on the original hash
```

The third run must be a cache miss. If it is a hit, the env passthrough is broken.

### Rules for adding new test-affecting env vars

Any time you add `process.env["FOO"]`-based branching to a `*.test.ts` or
anything that runs during vitest, you **must**:

1. Add `FOO` to `tasks.test.env` AND `tasks.test:coverage.env` in `turbo.json`.
2. Document it in the list above.
3. Verify with the `--dry=json` hash comparison above.

Without step 1, turbo will cache the wrong result and the gate/flag becomes
silently ineffective.

---

## MCP Server E2E Tests (real AWS)

Full lifecycle tests for all 37 resource types through the MCP server: plan → estimate → apply → list → destroy → verify.

### Prerequisites

- AWS credentials configured (root account or IAM with full access)
- IAM policy v18+ deployed (cloudformation:\*, iam:CreateServiceLinkedRole)
- Region: us-east-1
- Clean stale resources: `aws resourcegroupstaggingapi get-resources --tag-filters Key=managed-by,Values=assignee-ai`

### Running

```bash
# Build first (E2E uses compiled MCP server)
npx turbo build --force

# Full run — 25 types × 6 steps = 150 test steps
node apps/mcp-server/e2e-test.mjs 2>&1 | tee /tmp/mcp-e2e.log

# Single resource type
node apps/mcp-server/e2e-test.mjs --type Lambda
node apps/mcp-server/e2e-test.mjs --type RDS

# Smoke test (cheap resources only)
node apps/mcp-server/e2e-test.mjs --smoke
```

### What it tests

| Step     | What                                       | Validated                                   |
| -------- | ------------------------------------------ | ------------------------------------------- |
| plan     | LLM generates CloudFormation desired state | Schema compliance, required fields          |
| estimate | Cost estimation from pricing MCP           | Price returned or N/A                       |
| apply    | CloudControl provisions real resource      | Resource created, ARN returned              |
| list     | Tagging API finds the resource             | managed-by tag, correct type                |
| destroy  | CloudControl + pre-delete hooks            | Resource deleted, dependencies handled      |
| verify   | Confirm resource absent                    | Tagging API de-index or AWS API state check |

### Resource types (37 first-class CCAPI types, 0 SDK-routable)

All 37 supported resource types flow through the CloudControl API (35 with dedicated plugins + 2 compound-only types — `EC2::VPCGatewayAttachment`, `EC2::SubnetRouteTableAssociation` — that share the generic fallback plugin). There are no remaining SDK write paths. See [docs/resource-types.md](resource-types.md) for the full list including the recently added EFS (FileSystem + MountTarget), EventBridge (Rule, EventBus, Connection, ApiDestination), KMS Key, CloudFront (Distribution + OriginAccessControl), S3 BucketPolicy, and SNS Subscription. 10 compound patterns are exercised end-to-end (VPC networking, VPC public-only, lambda-with-exec-role, efs-with-vpc, static-website, scheduled-lambda, serverless-api, message-processing, container-service, three-tier-web).

### Cost

Actual AWS costs for a full end-to-end run vary by region and pricing changes. Most resources are free-tier; RDS, ELB, and NAT Gateway are the usual cost drivers. Run `assignee cost` for live pricing before invoking the suite if cost visibility matters.

### Duration

~43 minutes. RDS provisioning is the bottleneck (~8 min apply + ~5 min destroy).

---

## Unit tests

```bash
pnpm test          # ~7595 tests across 303 files (168 CLI + 100 core + 11 BP + 24 MCP)
pnpm check-types   # TypeScript type check
```

### Test fixtures — real MCP mock responses

All MCP mock responses in `apps/cli/src/test-fixtures/mcp-mock-responses.ts` are captured from **live MCP servers** (`aws-pricing-mcp-server`, `aws-documentation-mcp-server`, `iam-mcp-server`, `well-architected-security-mcp-server`, `billing-cost-management-mcp-server`). No fabricated data.

> **Historical note:** the CFN schema fixtures were originally captured from the now-removed `awslabs.cfn-mcp-server` (Story 7.6 migrated CloudFormation schema access to `@aws-sdk/client-cloudformation`). The cached JSON fixtures remain valid because they shape-match what the SDK returns; they are no longer regenerated. See `apps/cli/scripts/capture-mcp-responses.mjs` for the legacy capture path.

**What's included:**

| Category                  | Count | Source                                                                                                   |
| ------------------------- | ----- | -------------------------------------------------------------------------------------------------------- |
| CFN schemas               | 8     | historical capture from `awslabs.cfn-mcp-server` (now via `@aws-sdk/client-cloudformation`)              |
| Pricing                   | 11    | `awslabs.aws-pricing-mcp-server`                                                                         |
| Doc search                | 4     | `awslabs.aws-documentation-mcp-server`                                                                   |
| Doc read sections         | 5     | `awslabs.aws-documentation-mcp-server`                                                                   |
| Doc read full             | 2     | `awslabs.aws-documentation-mcp-server`                                                                   |
| IAM                       | 3     | `awslabs.iam-mcp-server` (s3BucketAllowed, ec2InstancePartialDeny, lambdaFunctionAllowed)                |
| Well-Architected Security | 2     | `awslabs.well-architected-security-mcp-server` (s3BucketPosture, noFindings)                             |
| Billing                   | 4     | `awslabs.billing-cost-management-mcp-server` (s3BucketCost, multiResourceCost, noCostData, costForecast) |

Total: ~39 captured responses, plus synthetic edge cases (empty responses, malformed JSON, null, errors) for boundary testing.

**Usage in tests:**

```typescript
import {
  McpMocks,
  createMockTool,
  createPricingMockTools,
  createIamMockTool,
  createSecurityMockTool,
  createBillingMockTool,
  createS3PricingDispatchTool,
  createServicePricingDispatchTool,
  createEc2PricingDispatchTool,
  createRdsPricingDispatchTool,
  RawSchemasByType,
} from "../test-fixtures/mcp-mock-responses.js";

// Single mock tool
const tool = createMockTool(
  ToolName.GET_PRICING,
  McpMocks.pricing.s3Storage.success,
);

// Pre-built tool sets (pricing only — schema uses CloudFormationSchemaService mock)
const tools = createPricingMockTools(McpMocks.pricing.ec2T3Micro.success);

// Domain-specific mock tools
const iamTool = createIamMockTool(McpMocks.iam.s3BucketAllowed);
const secTool = createSecurityMockTool(McpMocks.security.s3BucketPosture);
const billTool = createBillingMockTool(McpMocks.billing.s3BucketCost);

// Filter-dispatched pricing mocks (return DIFFERENT prices based on the
// filter string in the pricing query — e.g., storage vs PUT vs GET vs
// data transfer for S3, or compute vs EBS vs data transfer for EC2)
import {
  createS3PricingDispatchTool,
  createServicePricingDispatchTool,
} from "../test-fixtures/mcp-mock-responses.js";

const s3PricingTool = createS3PricingDispatchTool();
const ec2PricingTool = createServicePricingDispatchTool({
  computePrice: "0.0104",
  storagePrice: "0.08",
  dataTransferPrice: "0.09",
});
```

### Filter-dispatched pricing mocks

The cost estimator decomposes resource pricing into line items (e.g., S3 storage, PUT requests, GET requests, data transfer). Each line item issues a separate pricing MCP call with a different `filter` parameter. The `createS3PricingDispatchTool()` and `createServicePricingDispatchTool()` factories return mock tools that inspect the filter string and return the correct price for each line item. This catches bugs where the wrong price is applied to the wrong line item.

```typescript
// S3: dispatches based on filter keywords (storage, PUT, GET, data transfer)
const tool = createS3PricingDispatchTool();

// Generic services (EC2, RDS, etc.): dispatches based on service-specific filters
const tool = createServicePricingDispatchTool({
  computePrice: "0.0104", // compute/instance hours
  storagePrice: "0.08", // EBS/storage
  dataTransferPrice: "0.09", // data transfer
});
```

**Refreshing fixtures from live servers:**

```bash
cd apps/cli/scripts
node capture-mcp-responses.mjs      # spawns MCP servers, captures ~39 responses (requires .env)
node process-captured-responses.mjs  # trims schemas/pricing/docs to fixture size
```

> `build-fixture-ts.mjs` is **disabled** (exits 2) since story 48-10 split the
> monolithic fixture into per-resource files under
> `packages/core/src/test-fixtures/mcp-mock-responses/`. To add or update fixtures,
> edit the per-resource files directly — see the directory layout and the facade
> re-export in `mcp-mock-responses.ts`.

> `captured-responses/` is now tracked in git (committed alongside the TypeScript fixture). `processed-responses/` is still gitignored — only the final TypeScript fixture and the raw captures are committed.

### Key test files

| File                                  | Tests | What it covers                                                                                             |
| ------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------- |
| `graph-integration.test.ts`           | 29    | Full graph pipeline: S3, EC2, Lambda, IAM, DynamoDB, error paths, pricing edge cases                       |
| `preflight-guard.test.ts`             | 10    | Required field validation, cost estimation, pricing timeout                                                |
| `intent-parser.test.ts`               | 11    | Resource type classification, compound pattern detection                                                   |
| `schema-fetcher.test.ts`              | 7     | MCP schema retrieval, error handling                                                                       |
| `option-elicitor.test.ts`             | ~50   | Interactive prompts, showIf conditionals, CI mode                                                          |
| `plan-generator.test.ts`              | 8     | LLM plan generation, JSON parsing                                                                          |
| `pricing-lookup.test.ts`              | 17    | EC2/RDS live price enrichment                                                                              |
| `result-formatter.test.ts`            | ~45   | Memory writes, security checks, output formatting                                                          |
| `status-poller.test.ts`               | —     | CloudControl status polling, timeout handling                                                              |
| `destroy.test.ts`                     | ~25   | Safe teardown, confirmation prompts, error paths                                                           |
| `list.test.ts`                        | 7     | Managed resource listing, filtering                                                                        |
| `status.test.ts`                      | 4     | Summary with cost totals                                                                                   |
| `resource-resolver.test.ts`           | 7     | Resource type resolution, ARN parsing                                                                      |
| `list-resources.test.ts`              | 14    | Resource enumeration, tag-based filtering                                                                  |
| `billing.test.ts`                     | 11    | Cost data retrieval, forecast, multi-resource aggregation                                                  |
| `status-aggregator.test.ts`           | 19    | Status rollup across multiple resources                                                                    |
| `memory.test.ts` (service)            | —     | Memory service read/write, hint retrieval                                                                  |
| `memory.test.ts` (core schema)        | —     | Memory schema validation                                                                                   |
| `iam-actions.test.ts`                 | 6     | IAM action resolution, permission checks                                                                   |
| `distribution.test.ts`                | —     | CLI + MCP server distribution packaging                                                                    |
| `mcp-servers.test.ts`                 | 6     | MCP server config loading, lifecycle                                                                       |
| `server.test.ts` (MCP)                | —     | MCP server startup, tool registration                                                                      |
| `plan-resource.test.ts` (MCP)         | —     | MCP plan-resource tool handler                                                                             |
| `apply-plan.test.ts` (MCP)            | —     | MCP apply-plan tool handler                                                                                |
| `list-managed-resources.test.ts`      | —     | MCP list-managed-resources tool handler                                                                    |
| `estimate-cost.test.ts` (MCP)         | —     | MCP estimate-cost tool handler                                                                             |
| Plugin tests (core)                   | ~100+ | S3, EC2, RDS, Lambda, generic plugin config hints                                                          |
| `bp-all-rules-audit.test.ts`          | 266   | All 185 BP rules fire correctly (manifest-tracked)                                                         |
| `bp-auto-fix-audit.test.ts`           | 55    | All 27 auto-fixable rules verified end-to-end                                                              |
| `compound-provisioning-audit.test.ts` | 69    | 8 of 10 compound patterns through dispatcher+provisioner (missing: lambda-with-exec-role, vpc-public-only) |
| `compound-failure-injector.test.ts`   | 12    | Failure-injection harness: in-memory port, tracker, synthetic error at index N                             |
| `compound-cleanup-matrix.test.ts`     | 19    | VPC 17-position reverse-edge cleanup invariant (parameterized)                                             |
| `compound-smoke-trace.test.ts`        | 21    | Happy-path smoke + marker-ref validation for 6 compound patterns                                           |
| `apply-mode-audit.test.ts`            | 5     | Full apply mode: plan->bp->fix->approval->provision->result                                                |
| `destroy-service.test.ts`             | 16    | destroySingleResource: CloudControl, SDK fallback, CloudFront                                              |
| `s3-upload.test.ts`                   | 19    | S3 file upload with MIME types, progress, error handling                                                   |
| `bulk-destroy.test.ts`                | 21    | Tier ordering, IAM exclusion, pattern filtering                                                            |
| `decomposer-integration.test.ts`      | —     | Decomposer integration across all resource types                                                           |
| `bp-enforcement-integration.test.ts`  | —     | Best-practice enforcement modes (enforce/warn/skip) integration                                            |
| `secure-defaults-audit.test.ts`       | —     | Secure default values audit across all resource types                                                      |
| `cost-estimator-e2e.test.ts`          | —     | Cost estimator end-to-end with real pricing data                                                           |
| `coverage.test.ts`                    | 47    | Integration: asserts 23/23 pricing strategies + 23/23 decomposers registered                               |

### Pricing decomposer tests (Epic 39)

All supported resource types have pricing decomposers registered in `packages/core/src/pricing/index.ts`. Each decomposer breaks a resource into billable line items (e.g., EC2 → compute + storage + IPv4 + data transfer) with real AWS Pricing API `serviceCode` and `productFamily` filter values.

**Test files** in `packages/core/src/pricing/decomposers/`:

| File                       | Tests | What it covers                                                                  |
| -------------------------- | ----- | ------------------------------------------------------------------------------- |
| `ec2.test.ts`              | ~10   | Compute, EBS volumes, public IPv4, data transfer; instance type extraction      |
| `rds.test.ts`              | ~10   | Compute, storage, backup; Multi-AZ vs Single-AZ; engine mapping                 |
| `s3.test.ts`               | 7     | Storage, PUT/GET requests, data transfer; all usage-based                       |
| `lambda.test.ts`           | ~6    | Requests, duration (GB-seconds), CloudWatch Logs                                |
| `dynamodb.test.ts`         | ~8    | PAY_PER_REQUEST vs PROVISIONED; read/write capacity; storage                    |
| `nat-gateway.test.ts`      | 9     | Hourly rate (fixed) + data processing (usage-based)                             |
| `elbv2.test.ts`            | ~10   | ALB vs NLB detection (case-insensitive); hourly + LCU/NLCU                      |
| `apigatewayv2.test.ts`     | 8     | HTTP vs WEBSOCKET protocol; requests + data transfer / messages + minutes       |
| `sqs.test.ts`              | ~8    | Standard vs FIFO (boolean + string "true" + .fifo suffix); productFamily switch |
| `sns.test.ts`              | ~8    | Standard vs FIFO detection; publishes + HTTP notifications                      |
| `secretsmanager.test.ts`   | ~8    | Fixed secret storage + usage-based API calls                                    |
| `cloudwatch-alarm.test.ts` | ~10   | Standard vs High Resolution (Period < 60); boundary: 0, null, NaN               |
| `logs.test.ts`             | ~8    | STANDARD vs INFREQUENT_ACCESS class; ingestion + storage                        |
| `ecr.test.ts`              | 6     | Single storage line item (usage-based)                                          |
| `ssm.test.ts`              | ~10   | Standard tier (free, empty array) vs Advanced (2 items); case-insensitive Tier  |
| `free.test.ts`             | 24    | 8 free resources (VPC, Subnet, SG, IAM, IGW, RT, Route, ECS) → empty arrays     |
| `red-team.test.ts`         | 368   | All 23 decomposers × 16 adversarial inputs (NaN, null, undefined, wrong types)  |
| `coverage.test.ts`         | 47    | Integration: asserts 23/23 pricing strategies + 23/23 decomposers registered    |

### Cost estimator and free tier tests (Epic 40)

| File (MCP server)              | Tests | What it covers                                                                        |
| ------------------------------ | ----- | ------------------------------------------------------------------------------------- |
| `cost-estimator.test.ts`       | 33    | All supported types reachable via NL keywords; substring collision safety; case tests |
| `free-tier.test.ts`            | 19    | 9 always-free + 4 usage-limited + paid types return null                              |
| `coverage-consistency.test.ts` | 41    | Cross-system: keyword coverage + free tier maps sync + paid exclusion                 |

---

## End-to-end smoke tests

> Status: this section was an executable runbook of 54 manual smoke tests
> (Test 1 — Test 54). It has been superseded by automated coverage and is
> no longer kept in step with HEAD. The condensed checklist below is kept
> for at-a-glance scope tracking only.

The same lifecycle coverage now lives in code:

- **CLI E2E gate** — `apps/cli/src/e2e/e2e-plan.test.ts` (31 specs, run via
  `RUN_E2E=1 npx vitest run src/e2e/e2e-plan.test.ts --reporter=verbose`).
  Each spec exercises the full plan → apply → list → destroy → list lifecycle
  against real AWS for one resource type or compound pattern.
  **Current score: 28-29 pass / 0-1 fail / 2 skip** (up from the 19/12/0
  baseline). Known skips: `three-tier-web` and `container-service` (skeleton
  patterns needing VPC redesign before they can run reliably in E2E).
  All other compounds are covered (VPC, lambda-with-exec-role, efs-with-vpc,
  static-website, scheduled-lambda, serverless-api, message-processing) plus
  the VPC EIP-leak regression and SSM single-resource apply.
- **MCP Server E2E** — `apps/mcp-server/e2e-test.mjs` (see the section above
  for the `RUN_E2E_MCP=1` gate, mirrors the CLI lifecycle through the MCP API).
- **Plan-only / dry-run coverage** — the unit suite under
  `apps/cli/src/__tests__/` covers every supported resource type with the
  same plan-shape assertions the manual tests used to verify, plus the
  preflight, BP, and credential fail-fast scenarios.

When the runbook needs to be revived for a release rehearsal, recover it
from git history: `git log --diff-filter=D --follow -- docs/testing-guide.md`
and pick the commit prior to the IA reorganization.

### Recent E2E infrastructure improvements

The following mechanisms were added to improve E2E reliability and isolation:

- **`destroyAndAssert()` helper** — a shared test utility that wraps the
  destroy lifecycle with post-destroy verification (list confirms the
  resource is gone). This replaces ad-hoc destroy-then-check sequences in
  individual specs and ensures destroy isolation between tests.

  ```ts
  /**
   * Run bulk-destroy but only assert on failures for resources THIS test
   * created. planBulkDestroy sweeps the entire account — stale resources
   * from prior test runs (orphaned NAT Gateways, RGTA tag cache ghosts)
   * would cause false failures if we asserted on the full failure list.
   *
   * Filter: a destroy failure is only reported if the resource's identifier
   * matches one of the completedResources from this test's apply phase.
   */
  async function destroyAndAssert(
    completed: Array<{ resourceArn?: string; resourceType: string }>,
  ): Promise<void>;
  ```

  The helper imports `planBulkDestroy` and `destroySingleResource` at call
  time, builds a set of ARNs from the `completed` array, runs bulk destroy
  across the account, and only fails (via `expect(failures).toEqual([])`)
  for resources whose identifier matches one the current test created.

- **CloudFront S3 DNS retry mechanism** — the `resource-provisioner`
  retries S3 origin DNS resolution during CloudFront distribution creation.
  S3 bucket DNS can take seconds to propagate globally; without the retry
  the distribution would fail with an origin-not-found error on fast
  apply runs.

- **EFS pre-delete hook** — `destroy-service` runs a pre-delete hook for
  EFS file systems that removes mount targets before deleting the file
  system. CCAPI cannot delete an EFS file system while mount targets are
  still attached.

- **Static-website dependency group ordering fix** — the compound
  provisioner now correctly tiers the static-website resources so that
  `BucketPolicy` is destroyed first (tier 0), then the distribution
  (tier 1, two-step disable+delete), then OAC (tier 2), then the bucket
  (tier 5). This prevents dangling-reference errors during teardown.

---

## Smoke test checklist

Run all tests and mark pass/fail:

| #   | Test                                                                                         | Result |
| --- | -------------------------------------------------------------------------------------------- | ------ |
| 1   | `plan` renders box in <3s                                                                    | ⬜     |
| 2   | `apply` + approve → S3 bucket created with 3 tags                                            | ⬜     |
| 3   | `apply` + decline → exits 0, no resource                                                     | ⬜     |
| 4   | State Guard — second apply aborts with "Stale Plan"                                          | ⬜     |
| 5   | Unsupported type → actionable error with all 37 supported types                              | ⬜     |
| 6   | SSM Parameter provisioning                                                                   | ⬜     |
| 7   | IAM Role provisioning, cost shows Free                                                       | ⬜     |
| 8   | Non-TTY / pipe → no ANSI codes                                                               | ⬜     |
| 9   | S3 option elicitation — prompts for BucketName, encryption, versioning                       | ⬜     |
| 10  | EC2 option elicitation — InstanceType enum with live per-hour prices from the Pricing MCP    | ⬜     |
| 11  | RDS option elicitation — DBInstanceClass enum with live per-hour prices from the Pricing MCP | ⬜     |
| 12  | Option elicitation — CI mode (non-TTY) skips all prompts                                     | ⬜     |
| 13  | Compound plan — `create a serverless api` shows IAM Role plan box                            | ⬜     |
| 14  | Compound apply — `deploy a static website` → S3 + compound success box                       | ⬜     |
| 15  | Compound apply — message processing → partial failure + cleanup warning                      | ⬜     |
| 16  | Compound apply — full success (5 resources) with valid Lambda zip                            | ⬜     |
| 17  | Prompt injection — null bytes, `${`, unicode overrides stripped safely                       | ⬜     |
| 18  | Credential fail-fast — invalid creds error in <5s                                            | ⬜     |
| 19  | Lambda Function single-resource plan with elicitation                                        | ⬜     |
| 20  | DynamoDB Table single-resource plan                                                          | ⬜     |
| 21  | Pattern detection logged — no Bedrock call for compound intents                              | ⬜     |
| 22  | `assignee list` — shows managed resources                                                    | ⬜     |
| 23  | `assignee destroy` — safe teardown with "yes" confirmation                                   | ⬜     |
| 24  | `assignee status` — summary with cost totals                                                 | ⬜     |
| 25  | `assignee init` — project setup                                                              | ⬜     |
| 26  | `assignee plan --no-wizard` — non-interactive plan                                           | ⬜     |
| 27  | `assignee apply --yes --checkpoint` — CI mode auto-confirm                                   | ⬜     |
| 28  | Best practices findings in plan output                                                       | ⬜     |
| 29  | Memory hints ("Previous provision: <live monthly cost from Pricing MCP>") in plan output     | ⬜     |
| 30  | Static Website Deploy — S3 + CloudFront + file upload via `--source`                         | ⬜     |
| 31  | VPC Networking pattern — 17 resources, dependency ordering, NAT+EIP                          | ⬜     |
| 34  | SQS Queue plan — encryption + DLQ best practices                                             | ⬜     |
| 35  | SNS Topic plan — KMS encryption best practice                                                | ⬜     |
| 36  | DynamoDB Table plan — key schema, PITR, deletion protection                                  | ⬜     |
| 37  | EC2 Instance plan — instance type, pricing breakdown, IMDSv2                                 | ⬜     |
| 38  | RDS DBInstance plan — engine selection, encryption, Multi-AZ                                 | ⬜     |
| 39  | ECS Cluster plan — free cost estimate                                                        | ⬜     |
| 40  | ECR Repository plan — image scanning, tag immutability                                       | ⬜     |
| 41  | Lambda Function plan — runtime, memory, DLQ, arm64                                           | ⬜     |
| 42  | CloudWatch Alarm plan — metric, threshold, alarm actions                                     | ⬜     |
| 43  | SecretsManager Secret plan — KMS, rotation schedule                                          | ⬜     |
| 44  | ApiGatewayV2 API plan — access logging, CORS, authorization                                  | ⬜     |
| 45  | Logs LogGroup plan — retention auto-fix, KMS encryption                                      | ⬜     |
| 46  | SecurityGroup plan — SSH restriction, ingress rules                                          | ⬜     |
| 47  | VPC plan (single) — CIDR, DNS hostnames, flow logs                                           | ⬜     |
| 48  | Static website --source — S3 + CloudFront + file upload E2E                                  | ⬜     |
| 49  | --source single S3 — no CloudFront, public-read policy                                       | ⬜     |
| 50  | Container Service pattern — ECR + ECS + IAM                                                  | ⬜     |
| 51  | Three-Tier Web pattern — EC2 + RDS + SecurityGroup                                           | ⬜     |
| 52  | Drift detection — detect + reconcile flow                                                    | ⬜     |
| 53  | CCAPI redirect types — Lambda Permission, ElastiCache ReplicationGroup                       | ⬜     |
| 54  | Bulk destroy all types — create, list, dry-run, destroy, verify                              | ⬜     |

Tests 1–8 passing = Core demo-ready.
Tests 9–12 passing = Option elicitation (Story 7.3) verified.
Tests 13–16 passing = Compound provisioning (Story 8.2) verified.
Tests 17–18 passing = Architecture hardening (Epic 9) verified.
Tests 19–21 passing = Expanded resource types + pattern logging verified.
Tests 22–25 passing = Utility commands (list, destroy, status, init) verified.
Tests 26–27 passing = CI/non-interactive mode verified.
Tests 28–29 passing = Best practices + memory integration verified.
Tests 30–32 passing = Static website deploy, bulk destroy, clean resources verified.
Tests 33 passing = VPC networking compound pattern verified.
Tests 34–47f passing = All 23 individual resource type plans verified (including Subnet, IGW, RouteTable, Route, NAT Gateway, ELBv2).
Tests 48–49 passing = File upload with --source flag verified.
Tests 50–51 passing = Compound patterns (container, three-tier) verified.
Tests 52 passing = Drift detection and reconciliation verified.
Tests 53 passing = CCAPI redirect types verified.
Tests 54 passing = Full lifecycle bulk operations verified.
