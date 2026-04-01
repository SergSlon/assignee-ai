# Testing Guide — Assignee.ai CLI-First MVP

> Unit tests (Vitest), MCP server E2E tests against real AWS, and end-to-end smoke tests for the CLI commands.

---

## Quick reference

```bash
pnpm test                                    # ~3817 unit tests across 187 files, ~37s, no AWS needed
pnpm check-types                             # TypeScript type check
pnpm --filter @assignee/mcp-server test:e2e  # MCP E2E against real AWS (~43 min)
```

---

## MCP Server E2E Tests (real AWS)

Full lifecycle tests for all 25 resource types through the MCP server: plan → estimate → apply → list → destroy → verify.

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

### Resource types (23 supported + 2 SDK-routable = 25 total)

22 individual: SSM-Parameter, IAM-Role, S3-Bucket, DynamoDB-Table, SQS-Queue, SNS-Topic, ECS-Cluster, ECR-Repository, Lambda-Function, LogGroup, CloudWatch-Alarm, SecretsManager, VPC, InternetGateway, Subnet, RouteTable, Route, SecurityGroup, EC2-Instance, RDS-DBInstance, ELBv2-LoadBalancer, NatGateway.

3 compound: API-Gateway-V2 (serverless-api pattern), Compound-MessageQueue, Compound-ServerlessAPI.

### Cost

Most resources are free-tier or cost <$0.01. RDS and ELB are the most expensive (~$0.10 total for a run). NatGateway allocates an EIP (free when attached, cleaned up after). Total cost per full run: **~$0.15**.

### Duration

~43 minutes. RDS provisioning is the bottleneck (~8 min apply + ~5 min destroy).

---

## Unit tests

```bash
pnpm test          # ~4448 tests across 198 files (105 CLI + 73 core + 9 BP + 16 MCP)
pnpm check-types   # TypeScript type check
```

### Test fixtures — real MCP mock responses

All MCP mock responses in `apps/cli/src/test-fixtures/mcp-mock-responses.ts` are captured from **live MCP servers** (cfn-mcp-server, aws-pricing-mcp-server, aws-documentation-mcp-server). No fabricated data.

**What's included:**

| Category                  | Count | Source server                                                                             |
| ------------------------- | ----- | ----------------------------------------------------------------------------------------- |
| CFN schemas               | 8     | `awslabs.cfn-mcp-server`                                                                  |
| Pricing                   | 11    | `awslabs.aws-pricing-mcp-server`                                                          |
| Doc search                | 4     | `awslabs.aws-documentation-mcp-server`                                                    |
| Doc read sections         | 5     | `awslabs.aws-documentation-mcp-server`                                                    |
| Doc read full             | 2     | `awslabs.aws-documentation-mcp-server`                                                    |
| IAM                       | 3     | `awslabs.iam-mcp-server` (s3BucketAllowed, ec2InstancePartialDeny, lambdaFunctionAllowed) |
| Well-Architected Security | 2     | `awslabs.well-architected-mcp-server` (s3BucketPosture, noFindings)                       |
| Billing                   | 4     | `awslabs.billing-mcp-server` (s3BucketCost, multiResourceCost, noCostData, costForecast)  |

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
node build-fixture-ts.mjs           # generates final mcp-mock-responses.ts
```

> `captured-responses/` is now tracked in git (committed alongside the TypeScript fixture). `processed-responses/` is still gitignored — only the final TypeScript fixture and the raw captures are committed.

### Key test files

| File                                  | Tests | What it covers                                                                       |
| ------------------------------------- | ----- | ------------------------------------------------------------------------------------ |
| `graph-integration.test.ts`           | 29    | Full graph pipeline: S3, EC2, Lambda, IAM, DynamoDB, error paths, pricing edge cases |
| `preflight-guard.test.ts`             | 10    | Required field validation, cost estimation, pricing timeout                          |
| `intent-parser.test.ts`               | 11    | Resource type classification, compound pattern detection                             |
| `schema-fetcher.test.ts`              | 7     | MCP schema retrieval, error handling                                                 |
| `option-elicitor.test.ts`             | ~50   | Interactive prompts, showIf conditionals, CI mode                                    |
| `plan-generator.test.ts`              | 8     | LLM plan generation, JSON parsing                                                    |
| `pricing-lookup.test.ts`              | 17    | EC2/RDS live price enrichment                                                        |
| `result-formatter.test.ts`            | ~45   | Memory writes, security checks, output formatting                                    |
| `status-poller.test.ts`               | —     | CloudControl status polling, timeout handling                                        |
| `destroy.test.ts`                     | ~25   | Safe teardown, confirmation prompts, error paths                                     |
| `list.test.ts`                        | 7     | Managed resource listing, filtering                                                  |
| `status.test.ts`                      | 4     | Summary with cost totals                                                             |
| `resource-resolver.test.ts`           | 7     | Resource type resolution, ARN parsing                                                |
| `list-resources.test.ts`              | 14    | Resource enumeration, tag-based filtering                                            |
| `billing.test.ts`                     | 11    | Cost data retrieval, forecast, multi-resource aggregation                            |
| `status-aggregator.test.ts`           | 19    | Status rollup across multiple resources                                              |
| `memory.test.ts` (service)            | —     | Memory service read/write, hint retrieval                                            |
| `memory.test.ts` (core schema)        | —     | Memory schema validation                                                             |
| `iam-actions.test.ts`                 | 6     | IAM action resolution, permission checks                                             |
| `distribution.test.ts`                | —     | CLI + MCP server distribution packaging                                              |
| `mcp-servers.test.ts`                 | 6     | MCP server config loading, lifecycle                                                 |
| `server.test.ts` (MCP)                | —     | MCP server startup, tool registration                                                |
| `plan-resource.test.ts` (MCP)         | —     | MCP plan-resource tool handler                                                       |
| `apply-plan.test.ts` (MCP)            | —     | MCP apply-plan tool handler                                                          |
| `list-managed-resources.test.ts`      | —     | MCP list-managed-resources tool handler                                              |
| `estimate-cost.test.ts` (MCP)         | —     | MCP estimate-cost tool handler                                                       |
| Plugin tests (core)                   | ~100+ | S3, EC2, RDS, Lambda, generic plugin config hints                                    |
| `bp-all-rules-audit.test.ts`          | 256   | All 130 BP rules fire correctly (was 18/142)                                         |
| `bp-auto-fix-audit.test.ts`           | 55    | All 27 auto-fixable rules verified end-to-end                                        |
| `compound-provisioning-audit.test.ts` | 69    | All 6 compound patterns through dispatcher+provisioner                               |
| `apply-mode-audit.test.ts`            | 5     | Full apply mode: plan->bp->fix->approval->provision->result                          |
| `destroy-service.test.ts`             | 16    | destroySingleResource: CloudControl, SDK fallback, CloudFront                        |
| `cloudfront-setup.test.ts`            | 9     | CloudFront distribution + OAC creation                                               |
| `s3-upload.test.ts`                   | 19    | S3 file upload with MIME types, progress, error handling                             |
| `bulk-destroy.test.ts`                | 21    | Tier ordering, IAM exclusion, pattern filtering                                      |

### Pricing decomposer tests (Epic 39)

All 23 resource types have pricing decomposers registered in `packages/core/src/pricing/index.ts`. Each decomposer breaks a resource into billable line items (e.g., EC2 → compute + storage + IPv4 + data transfer) with real AWS Pricing API `serviceCode` and `productFamily` filter values.

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

| File (MCP server)              | Tests | What it covers                                                                 |
| ------------------------------ | ----- | ------------------------------------------------------------------------------ |
| `cost-estimator.test.ts`       | 33    | All 23 types reachable via NL keywords; substring collision safety; case tests |
| `free-tier.test.ts`            | 19    | 9 always-free + 4 usage-limited + paid types return null                       |
| `coverage-consistency.test.ts` | 41    | Cross-system: keyword coverage + free tier maps sync + paid exclusion          |

---

## End-to-end smoke tests

> All smoke tests run against real AWS (us-east-1, account 054125018476).

## Prerequisites

```bash
# 1. Install dependencies and build
cd /Users/serhii_l/code/GenAi/assignee.ai
pnpm install
pnpm build

# 2. Verify .env is populated
cat .env
# Must contain: ASSIGNEE_OPERATOR_ACCESS_KEY_ID, ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY, AWS_REGION,
#               ASSIGNEE_READER_ACCESS_KEY_ID, ASSIGNEE_READER_SECRET_ACCESS_KEY,
#               ASSIGNEE_AUDITOR_ACCESS_KEY_ID, ASSIGNEE_AUDITOR_SECRET_ACCESS_KEY

# 3. Verify unit tests pass
pnpm test
```

> **AWS credentials for verification commands:** The `aws` CLI commands below rely on
> credentials already exported in your shell (e.g. via `source .env`, `aws configure`,
> or an AWS SSO session). Do not paste credentials directly into commands.

**Helper alias** (optional — save typing):

```bash
alias assignee="node /Users/serhii_l/code/GenAi/assignee.ai/apps/cli/dist/index.js"
```

All commands below assume this alias. Without it, replace `assignee` with:

```bash
node /Users/serhii_l/code/GenAi/assignee.ai/apps/cli/dist/index.js
```

---

## Test 1 — Plan command (no resources created)

**Purpose:** Verify the full plan pipeline works end-to-end: intent parsing → schema fetch → plan generation → cost estimate → terminal display.

```bash
assignee plan "Create an S3 bucket named poc-smoke-test"
```

**Expected terminal output:**

```
✦ Assignee.ai — AI-Native Cloud Operator
  Generating plan...

╔══════════════ Plan ═══════════════╗
║ Resource Type:  AWS::S3::Bucket   ║
║ Config:         { "BucketName":   ║
║                   "poc-smoke-test"║
║                   ... }           ║
║ Estimated Cost: ~$0.02/month      ║
║ Run ID:         <uuid>            ║
╚═══════════════════════════════════╝

✅ Operation completed successfully
```

**Check:**

- [ ] Plan box renders with Resource Type, Config, Estimated Cost, Run ID
- [ ] Completed in **<3 seconds** from prompt to box (NFR-05)
- [ ] No AWS resource created (check S3 console — bucket must NOT exist)
- [ ] Exits with code 0: `echo $?` → `0`

**Structured logs check** (stderr -- requires `--verbose` flag, logs are suppressed by default):

```bash
assignee plan --verbose "Create an S3 bucket named poc-smoke-test" 2>/tmp/assignee-logs.txt 1>/dev/null; jq . /tmp/assignee-logs.txt
```

Expected log sequence:

```json
{ "action": "intent_parsed",    "resourceType": "AWS::S3::Bucket" }
{ "action": "schema_fetched",   "resourceType": "AWS::S3::Bucket" }
{ "action": "plan_generated",   "durationMs": <number> }
{ "action": "preflight_completed", "costEstimate": "~$0.02/month" }
```

---

## Test 2 — Apply command — approve (creates real resource)

**Purpose:** Verify the full apply pipeline: plan → HITL confirm → CloudControl SDK provisioning → tag injection → status polling → success output.

> ⚠️ This creates a real S3 bucket in `us-east-1`. Clean up afterwards.

```bash
BUCKET="poc-apply-test-$(date +%s)"
assignee apply "Create an S3 bucket named $BUCKET"
```

At the confirmation prompt:

```
? Apply this plan to create AWS::S3::Bucket? [y/N]
```

→ type **`y`** and press Enter.

**Expected terminal output:**

```
✦ Assignee.ai — AI-Native Cloud Operator
  Generating plan...

[plan box]

? Apply this plan to create AWS::S3::Bucket? [y/N] › y
  Provisioning resource...
  Waiting for AWS Cloud Control API...

✅ Resource created successfully!
   ARN: arn:aws:s3:::poc-apply-test-<timestamp>
   Run ID: <uuid>

✅ Operation completed successfully
```

**Verify resource and tags in AWS:**

```bash
aws s3api get-bucket-tagging \
  --bucket $BUCKET \
  --region us-east-1
```

Expected tags (NFR-14):

```json
{
  "TagSet": [
    { "Key": "managed-by", "Value": "assignee-ai" },
    { "Key": "assignee-run-id", "Value": "<uuid>" },
    { "Key": "environment", "Value": "poc" }
  ]
}
```

**Verify Bedrock invocation was logged (NFR-10):**

```bash
aws logs filter-log-events \
  --log-group-name /assignee-ai/bedrock-invocations \
  --region us-east-1 \
  --start-time $(date -v -5M +%s000) \
  --output json | jq '.events[0].message // "No log events found" | fromjson? // .'
```

> Bedrock runs in `us-east-1` (`AWS_REGION` in `.env`) — logs are written there, not in `us-east-1`. `--output text --query 'events[0].message'` returns the literal string `None` when no events match (breaking `jq`); use `--output json` and extract via jq instead.

**Check:**

- [ ] Resource created and visible in AWS Console → S3
- [ ] All 3 mandatory tags present (`managed-by`, `assignee-run-id`, `environment`)
- [ ] ARN printed to terminal
- [ ] Exits 0: `echo $?` → `0`
- [ ] Bedrock invocation visible in CloudWatch log group

**Cleanup:**

```bash
aws s3 rb s3://$BUCKET --region us-east-1
```

---

## Test 3 — Apply command — decline (no resource created)

**Purpose:** Verify HITL rejection exits cleanly without provisioning.

```bash
assignee apply "Create an S3 bucket named poc-rejected-test"
```

At the confirmation prompt → type **`N`** or press **`Ctrl+C`**.

**Check:**

- [ ] Exits 0 (cancellation is not an error): `echo $?` → `0`
- [ ] No bucket created in AWS
- [ ] No error message shown — silent exit

---

## Test 4 — State Guard (stale plan detection)

**Purpose:** Verify Read-Before-Write guard aborts apply if resource already exists (FR-15).

```bash
BUCKET="poc-guard-test-$(date +%s)"

# First apply — creates the bucket
assignee apply "Create an S3 bucket named $BUCKET"
# → approve with y

# Second apply — must be rejected by State Guard
assignee apply "Create an S3 bucket named $BUCKET"
# → approve with y
```

**Expected on second run:**

```
✖ Error: Stale Plan: Resource already exists. Re-run 'assignee plan' to get a fresh plan.
  How to Fix: Run 'assignee plan' again to generate a current plan before applying.
```

**Check:**

- [ ] Second run exits 1: `echo $?` → `1`
- [ ] Error message contains "Stale Plan"
- [ ] Only one bucket exists in AWS (not duplicated)

**Cleanup:**

```bash
aws s3 rb s3://$BUCKET --region us-east-1
```

---

## Test 5 — Unsupported resource type

**Purpose:** Verify intent parser rejects unsupported types with an actionable error (NFR-08).

```bash
assignee plan "Create an ElastiCache cluster"
```

**Expected:**

```
✖ Error: Unsupported resource type.
  How to Fix: Supported types: AWS::S3::Bucket, AWS::SSM::Parameter, AWS::IAM::Role,
              AWS::EC2::Instance, AWS::RDS::DBInstance, AWS::Lambda::Function,
              AWS::EC2::VPC, AWS::EC2::Subnet, AWS::EC2::SecurityGroup,
              AWS::DynamoDB::Table, AWS::SQS::Queue, AWS::SNS::Topic,
              AWS::ElasticLoadBalancingV2::LoadBalancer, AWS::ECS::Cluster,
              AWS::ECR::Repository
```

**Check:**

- [ ] Exits 1: `echo $?` → `1`
- [ ] Error lists all 15 supported types
- [ ] No AWS call attempted

---

## Test 6 — SSM Parameter (second resource type)

```bash
assignee apply "Create an SSM parameter named /poc/test/greeting with value hello-world"
```

→ approve with `y`

**Verify:**

```bash
aws ssm get-parameter \
  --name /poc/test/greeting \
  --region us-east-1 \
  --query 'Parameter.Value' \
  --output text
# Expected: hello-world
```

**Cleanup:**

```bash
aws ssm delete-parameter --name /poc/test/greeting --region us-east-1
```

---

## Test 7 — IAM Role (third resource type)

**Purpose:** Verify end-to-end provisioning for `AWS::IAM::Role` — the third supported POC type.

```bash
ROLE="poc-test-role-$(date +%s)"
assignee apply "Create an IAM role named $ROLE that allows Lambda to assume it"
```

→ approve with `y`

**Verify role exists:**

```bash
aws iam get-role \
  --role-name "$ROLE" \
  --query 'Role.{Arn:Arn,CreateDate:CreateDate}' \
  --output json
```

**Verify tags (NFR-14):**

```bash
aws iam list-role-tags \
  --role-name "$ROLE" \
  --query 'Tags'
```

Expected tags:

```json
[
  { "Key": "managed-by", "Value": "assignee-ai" },
  { "Key": "assignee-run-id", "Value": "<uuid>" },
  { "Key": "environment", "Value": "poc" }
]
```

**Cost check:** IAM Roles are free — plan box should show `Estimated Cost: Free`.

**Check:**

- [ ] Role ARN printed to terminal
- [ ] Role visible in AWS Console → IAM → Roles
- [ ] All 3 mandatory tags present
- [ ] Plan box shows `Estimated Cost: Free`
- [ ] Exits 0: `echo $?` → `0`

**Cleanup:**

```bash
aws iam delete-role --role-name "$ROLE"
```

---

## Test 8 — Non-TTY mode (CI compatibility)

**Purpose:** Verify plain-text output without ANSI codes when stdout is piped (NFR-12).

```bash
assignee plan "Create an S3 bucket named poc-ci-test" | cat
```

**Expected:** Plain text without escape sequences or box-drawing characters.

```bash
# Confirm no ANSI codes
assignee plan "Create an S3 bucket named poc-ci-test" | cat | grep -P '\x1b\[' && echo "FAIL: ANSI found" || echo "PASS: no ANSI"
```

---

## Test 9 — Option Elicitation — S3 interactive prompts (Story 7.3)

**Purpose:** Verify the `option_elicitor` node asks structured questions when a plugin exists for the resource type.

```bash
assignee plan "Create an S3 bucket"
```

**Expected interaction sequence:**

```
✦ Assignee.ai — AI-Native Cloud Operator
  Parsing intent...

◆ Bucket name
│ my-bucket (leave blank for auto-generated)
│ ▌

◆ Enable server-side encryption?
│ ● Yes / ○ No

◆ KMS Key ID (leave blank for SSE-S3)    ← only appears if encryption = yes
│ arn:aws:kms:... (leave blank for SSE-S3)
│ ▌

◆ Block all public access?
│ ● Yes / ○ No

◆ Enable versioning?
│ ○ Yes / ● No

◆ Configure advanced options?
│ ○ Yes / ● No

[plan box with your chosen values]
```

**Check:**

- [ ] `BucketName` text prompt appears first
- [ ] `Enable server-side encryption?` boolean confirm appears
- [ ] `KMS Key ID` prompt only appears when encryption = yes (`showIf` conditional)
- [ ] `Block all public access?` and `Enable versioning?` prompts appear
- [ ] `Configure advanced options?` gate appears (answer No to skip)
- [ ] Plan box config reflects your choices
- [ ] Exits 0

**Advanced options tier** — run again and answer Yes to advanced options:

```
◆ Configure advanced options?
│ ● Yes / ○ No

◆ Add lifecycle rules?
│ ○ Yes / ● No

◆ Enable CORS?
│ ○ Yes / ● No

◆ Enable cross-region replication?
│ ○ Yes / ● No
```

- [ ] All 3 advanced fields appear when advanced = yes

---

## Test 10 — Option Elicitation — EC2 with live pricing (Story 7.3)

> **Note:** Actual prices come from AWS Pricing MCP at runtime. The dollar amounts shown below are examples and will vary by region and date.

**Purpose:** Verify EC2 instance type enum is enriched with live $/hr prices from the AWS Pricing MCP server.

```bash
assignee plan "Create an EC2 instance"
```

**Expected:**

```
◇ Fetching live EC2 instance prices…
◇ Live prices loaded

◆ Instance type
│ ○ t3.micro — $0.0104/hr
│ ○ t3.small — $0.0208/hr
│ ● t3.medium — $0.0416/hr
│ ○ t3.large — $0.0832/hr
│ ...
```

**Check:**

- [ ] Spinner `Fetching live EC2 instance prices…` appears briefly
- [ ] Instance type options include `— $X.XX/hr` price annotation
- [ ] Falls back to `Using estimated prices` (not a fatal error) if pricing MCP is unavailable

---

## Test 11 — Option Elicitation — RDS with live pricing (Story 7.3)

**Purpose:** Verify RDS DBInstanceClass enum is enriched with live prices.

```bash
assignee plan "Create an RDS PostgreSQL database"
```

**Expected:**

```
◇ Fetching live RDS instance prices…
◇ Live prices loaded

◆ Database engine
│ ● postgres / ○ mysql / ○ mariadb

◆ DB instance class
│ ● db.t3.micro — $0.017/hr
│ ○ db.t3.small — $0.034/hr
│ ...
```

**Check:**

- [ ] Spinner appears for RDS prices
- [ ] `DBInstanceClass` select options include `— $X.XX/hr` suffix

---

## Test 12 — Option Elicitation — CI mode skips all prompts (Story 7.3)

**Purpose:** Verify non-TTY mode uses defaults and never prompts (safe for CI pipelines).

```bash
assignee plan "Create an S3 bucket named poc-ci-elicit-test" | cat
```

**Check:**

- [ ] No interactive prompts appear
- [ ] Plan box generated using plugin defaults (encryption=true, public-access-blocked=true)
- [ ] No ANSI codes in output

---

## Test 13 — Compound plan preview — Serverless API (Stories 8.1, 8.2)

**Purpose:** Verify pattern detection and compound plan preview for a multi-resource intent.

```bash
assignee plan "create a serverless api"
```

**Expected:**

```
✦ Assignee.ai — AI-Native Cloud Operator
  Parsing intent...
  Fetching schema...
  Generating plan...

╔══════════════════════ Plan ══════════════════════════╗
║ Resource Type:   AWS::IAM::Role                      ║
║ Region:          us-east-1 (cross-regional ...)      ║
║ Config:          {                                   ║
║                    "Path": "/",                      ║
║                    "AssumeRolePolicyDocument": {...} ║
║                  }                                   ║
║ Estimated Cost:  Free                                ║
║ Run ID:          <uuid>                              ║
╚══════════════════════════════════════════════════════╝

✅ Operation completed successfully
```

> Plan mode shows the **first resource** (IAM Role) in the dependency order with its
> pattern defaults. The full pattern (IAM Role → Lambda → DynamoDB → API Gateway)
> is visible in the structured logs.

**Structured logs check:**

```bash
assignee plan "create a serverless api" 2>/tmp/compound-plan.txt 1>/dev/null
jq . /tmp/compound-plan.txt
```

**Check:**

- [ ] Plan box shows `AWS::IAM::Role` (first in dependency order)
- [ ] `Config` contains `AssumeRolePolicyDocument` from `pattern.defaultOptions`
- [ ] `Estimated Cost` shows `Free`
- [ ] No Bedrock LLM call made (instant — pattern matched by keyword)
- [ ] Exits 0

---

## Test 14 — Compound apply — Static Website pattern (Story 8.2)

**Purpose:** Verify the compound provisioning loop for the simplest pattern (1 resource).

> ⚠️ Creates a real S3 bucket. Clean up afterwards.

```bash
SITE_BUCKET="poc-static-site-$(date +%s)"
assignee apply "deploy a static website with bucket name $SITE_BUCKET"
```

→ approve with `y` at the HITL confirm.

**Expected terminal output:**

```
✦ Assignee.ai — AI-Native Cloud Operator
  ...

[plan box: AWS::IAM::Role → wait, S3 bucket for static-website]

? Apply this plan to create AWS::S3::Bucket? [y/N] › y
  Provisioning resource 1 of 1...

╔══════════ Compound Provisioning Complete ══════════╗
║ ✓ Static Website (S3 + CloudFront) provisioned    ║
║                                                    ║
║   1. AWS::S3::Bucket → arn:aws:s3:::poc-static-... ║
╚════════════════════════════════════════════════════╝

✅ Operation completed successfully
```

**Verify S3 website bucket settings:**

```bash
aws s3api get-bucket-tagging \
  --bucket $SITE_BUCKET \
  --region us-east-1

aws s3api get-public-access-block \
  --bucket $SITE_BUCKET \
  --region us-east-1
```

Expected: all 4 `BlockPublicAcls`, `BlockPublicPolicy`, `IgnorePublicAcls`, `RestrictPublicBuckets` = `true`.

**Check:**

- [ ] Compound success box appears with pattern name `Static Website (S3 + CloudFront)`
- [ ] 1 resource listed in the success box
- [ ] All 4 public-access-block settings are true (from `pattern.defaultOptions`)
- [ ] All 3 mandatory tags present (`managed-by`, `assignee-run-id`, `environment`)
- [ ] Exits 0

**Cleanup:**

```bash
aws s3 rb s3://$SITE_BUCKET --region us-east-1
```

---

## Test 15 — Compound apply — Message Processing pattern (Story 8.2)

**Purpose:** Verify a 5-resource compound provisioning loop (SQS DLQ → SQS Queue + DynamoDB + IAM Role → Lambda).

> ⚠️ Creates real AWS resources (2 SQS queues, 1 DynamoDB table, 1 IAM role, 1 Lambda function).
> Lambda provisioning **will fail** if `Handler` and `Code` are not supplied — this is a known
> pattern limitation (Lambda needs actual code). The test still validates that the compound
> loop advances through all resources and reports partial results correctly on Lambda failure.

```bash
assignee apply "create a message queue with lambda processor"
```

→ approve with `y`.

**Expected (partial success scenario):**

```
  Provisioning resource 1 of 5...   ← SQS DLQ
  Provisioning resource 2 of 5...   ← SQS main queue (parallel group)
  Provisioning resource 3 of 5...   ← DynamoDB table
  Provisioning resource 4 of 5...   ← IAM role
  Provisioning resource 5 of 5...   ← Lambda (may fail)

✖ Error: Provision halted at AWS::Lambda::Function.
         Previously provisioned: AWS::SQS::Queue, AWS::SQS::Queue,
         AWS::DynamoDB::Table, AWS::IAM::Role. Manual cleanup may be required.
```

**Check (partial results):**

- [ ] Spinner label shows `Provisioning resource N of 5` for each step
- [ ] If Lambda fails: compound FAILED error message lists previously provisioned resources
- [ ] "Manual cleanup may be required" appears in error message
- [ ] Exits 1 on failure

**Cleanup any created resources:**

```bash
# List and delete queues created for this run (check names in the error output or AWS console)
aws sqs list-queues --region us-east-1 | jq '.QueueUrls[]' | grep poc
# aws sqs delete-queue --queue-url <url> --region us-east-1

# DynamoDB table
aws dynamodb list-tables --region us-east-1

# IAM role
aws iam list-roles | jq '.Roles[].RoleName' | grep assignee
```

---

## Test 16 — Compound apply — Full success verification (Story 8.2)

**Purpose:** If you can supply a pre-built Lambda zip, verify the full 5-resource compound provisioning completes successfully.

> This test requires a Lambda deployment package. Skip if not available.

```bash
# Create a minimal Lambda zip
mkdir /tmp/lambda-poc && echo 'exports.handler = async () => ({ statusCode: 200 })' > /tmp/lambda-poc/index.js
cd /tmp/lambda-poc && zip handler.zip index.js

# Upload to S3 for Lambda to reference
aws s3 cp handler.zip s3://<your-bucket>/lambda-poc/handler.zip
```

Then run the apply with enough detail for the LLM to generate a working `desiredState` for Lambda:

```bash
assignee apply "create a message queue with lambda processor. Lambda handler: index.handler, code bucket: <your-bucket>, code key: lambda-poc/handler.zip"
```

**Expected compound success box:**

```
╔══════════════════════════════════════════════════════════════╗
║ ✓ Message Processing Pipeline provisioned successfully       ║
║                                                              ║
║   1. AWS::SQS::Queue → arn:aws:sqs:us-east-1:...:dlq        ║
║   2. AWS::SQS::Queue → arn:aws:sqs:us-east-1:...:main-queue ║
║   3. AWS::DynamoDB::Table → arn:aws:dynamodb:...            ║
║   4. AWS::IAM::Role → arn:aws:iam::...:role/...             ║
║   5. AWS::Lambda::Function → arn:aws:lambda:...             ║
╚══════════════════════════════════════════════════════════════╝
```

**Check:**

- [ ] All 5 resources listed in the compound success box
- [ ] Each line shows the real ARN
- [ ] Exits 0

---

## Test 17 — Prompt injection guard (Story 9.3)

**Purpose:** Verify `sanitizeUserIntent` strips control characters and template injection sequences (NFR-16).

```bash
# Null bytes stripped
assignee plan $'Create an S3 bucket\x00; rm -rf /'

# Template injection escaped
assignee plan 'Create an S3 bucket ${process.exit(1)}'

# Unicode direction override stripped
assignee plan $'Create an S3 bucket \u202e malicious suffix'
```

**Check for each command:**

- [ ] Command runs normally (no crash, no injection)
- [ ] Plan box or error output contains sanitized intent (no null bytes, `${` escaped to `$ {`)
- [ ] Exits 0 (sanitized) or 1 (unsupported type) — not a crash or segfault
- [ ] Logs show `userIntent` field with sanitized string

**Length truncation test:**

```bash
# 600-char input — should be silently truncated to 500 chars
LONG=$(python3 -c "print('Create an S3 bucket named test-' + 'x'*600)")
assignee plan "$LONG"
```

- [ ] Command completes (does not error on long input)

---

## Test 18 — Credential fail-fast (Story 9.2)

**Purpose:** Verify invalid AWS credentials produce an immediate, descriptive error rather than a timeout.

```bash
# Override credentials with invalid values
ASSIGNEE_OPERATOR_ACCESS_KEY_ID=AKIAINVALID ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY=invalidsecret \
  assignee plan "Create an S3 bucket named poc-cred-test"
```

**Expected:**

```
✖ Error: AWS credential validation failed.
  How to Fix: Run 'aws sts get-caller-identity' to verify your credentials,
              or check ASSIGNEE_OPERATOR_ACCESS_KEY_ID / ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY in your .env file.
```

**Check:**

- [ ] Error appears in **<5 seconds** (fail-fast, not a timeout)
- [ ] Exits 1
- [ ] Error message mentions credentials and how to fix
- [ ] No Bedrock API call attempted (credentials checked first)

---

## Test 19 — Lambda Function single-resource plan (Story 7.0 expanded types)

**Purpose:** Verify Lambda is classified and a plan is generated.

```bash
assignee plan "Create a Node.js Lambda function named my-api-handler"
```

**Expected:** Plan box with `AWS::Lambda::Function`, config shows `Runtime`, `MemorySize`, `Timeout` from the LLM + elicited options.

Option elicitation for Lambda:

```
◆ Function name
│ ▌

◆ Runtime
│ ● nodejs22.x / ○ python3.12 / ○ java21 / ...

◆ Memory size (MB)
│ ○ 128 / ○ 256 / ● 512 / ○ 1024 / ...

◆ Timeout (seconds)
│ ▌
```

**Check:**

- [ ] `resourceType` in plan box is `AWS::Lambda::Function`
- [ ] Runtime enum prompt appears with multiple options
- [ ] Memory size enum prompt appears
- [ ] Exits 0

---

## Test 20 — DynamoDB Table single-resource plan (Story 7.0 expanded types)

**Purpose:** Verify DynamoDB is classified and planned.

```bash
assignee plan "Create a DynamoDB table named poc-items with pay-per-request billing"
```

**Check:**

- [ ] `resourceType` in plan box is `AWS::DynamoDB::Table`
- [ ] Config includes `BillingMode: PAY_PER_REQUEST`
- [ ] Exits 0

---

## Test 21 — Pattern keyword detection logging (Story 8.1)

**Purpose:** Verify that pattern-matched intents bypass Bedrock and are logged appropriately.

```bash
assignee plan "create a serverless api" 2>/tmp/pattern-logs.txt 1>/dev/null
jq 'select(.action == "intent_parsed")' /tmp/pattern-logs.txt
```

**Expected log entry:**

```json
{
  "action": "intent_parsed",
  "extras": { "resourceType": null, "pattern": "serverless-api" }
}
```

> The `intent_parsed` log should show pattern detected, no Bedrock LLM call made.

**Check:**

- [ ] Log contains pattern ID (`serverless-api`)
- [ ] No `plan_generated` log with `durationMs > 0` from Bedrock (compound path uses `durationMs: 0`)

---

## Test 22 — List managed resources

**Purpose:** Verify `assignee list` displays all resources tagged with `managed-by: assignee-ai`.

```bash
assignee list
```

**Expected:** Table of managed resources with ARN, type, status, and run ID columns.

**Check:**

- [ ] Table renders with resource entries (or "No managed resources found" if none exist)
- [ ] Exits 0

---

## Test 23 — Destroy with confirmation

**Purpose:** Verify `assignee destroy` performs safe teardown with explicit "yes" confirmation.

> This test requires at least one managed resource. Create one with `assignee apply` first if needed.

```bash
assignee destroy
```

At the confirmation prompt, type **`yes`** to confirm teardown.

**Check:**

- [ ] Confirmation prompt requires typing "yes" (not just `y`)
- [ ] Resource is deleted from AWS after confirmation
- [ ] Exits 0

---

## Test 24 — Status with cost totals

**Purpose:** Verify `assignee status` shows a summary including cost totals for managed resources.

```bash
assignee status
```

**Expected:** Summary output with resource count and aggregated monthly cost.

**Check:**

- [ ] Status summary renders with resource counts
- [ ] Cost totals displayed (or "$0.00/month" if no resources)
- [ ] Exits 0

---

## Test 25 — Project initialization

**Purpose:** Verify `assignee init` sets up a new project configuration.

```bash
mkdir /tmp/assignee-init-test && cd /tmp/assignee-init-test
assignee init
```

**Check:**

- [ ] Project config file created
- [ ] Exits 0

**Cleanup:**

```bash
rm -rf /tmp/assignee-init-test
```

---

## Test 26 — Non-interactive plan

**Purpose:** Verify `assignee plan --no-wizard` skips all interactive prompts (useful for scripting and CI).

```bash
assignee plan --no-wizard "Create an S3 bucket named poc-no-wizard-test"
```

**Check:**

- [ ] No interactive prompts appear
- [ ] Plan box generated with defaults
- [ ] Exits 0

---

## Test 27 — CI mode apply with checkpoint

**Purpose:** Verify `assignee apply --yes --checkpoint` auto-confirms and enables checkpoint logging for CI pipelines.

```bash
BUCKET="poc-ci-apply-$(date +%s)"
assignee apply --yes --checkpoint "Create an S3 bucket named $BUCKET"
```

**Check:**

- [ ] No confirmation prompt (auto-approved via `--yes`)
- [ ] Checkpoint data written (visible in structured logs)
- [ ] Resource created successfully
- [ ] Exits 0

**Cleanup:**

```bash
aws s3 rb s3://$BUCKET --region us-east-1
```

---

## Test 28 — Best practices findings in plan output

**Purpose:** Verify that plan output includes best practices findings (security, cost, reliability).

```bash
assignee plan "Create an S3 bucket named poc-best-practices-test"
```

**Expected:** Plan output includes a findings section with best practices recommendations (e.g., encryption, public access block, versioning).

**Check:**

- [ ] Best practices findings appear in plan output
- [ ] Findings reference specific configuration recommendations
- [ ] Exits 0

---

## Test 29 — Memory hints in plan output

**Purpose:** Verify that plan output includes memory hints from previous provisions (e.g., "Previous provision: $X/month").

> This test requires at least one previous `assignee apply` for the same resource type to populate memory.

```bash
# First, ensure a previous S3 provision exists in memory
assignee plan "Create an S3 bucket named poc-memory-hint-test"
```

**Expected:** Plan output includes a memory hint like `Previous provision: $X/month` if a prior S3 provision exists.

**Check:**

- [ ] Memory hint appears if prior provision exists for this resource type
- [ ] Hint includes previous cost data
- [ ] Exits 0

---

## Test 30 — Static Website Deploy (creates S3 + CloudFront)

**Purpose:** Verify `--source` flag uploads files and creates CloudFront distribution.

```bash
mkdir -p /tmp/test-site && echo '<h1>Hello</h1>' > /tmp/test-site/index.html
assignee apply "Host a static website" --source /tmp/test-site --yes
```

**Check:**

- [ ] S3 bucket created with WebsiteConfiguration
- [ ] Files uploaded with correct MIME types
- [ ] CloudFront distribution created with OAC
- [ ] Website URL displayed (https://<id>.cloudfront.net)
- [ ] Bucket policy uses `aws:SourceArn` condition

**Cleanup:**

```bash
assignee destroy --all --yes
```

---

## Test 31 — Bulk Destroy

**Purpose:** Verify `destroy --all` with tier ordering and safety gates.

```bash
# Preview
assignee destroy --all --dry-run

# Execute (skip IAM)
assignee destroy --all --yes

# With IAM
assignee destroy --all --include-iam --yes
```

**Check:**

- [ ] Dry-run shows resources without destroying
- [ ] Resources destroyed in tier order (tier 1 first, tier 6 last)
- [ ] IAM excluded by default, included with --include-iam
- [ ] Summary shows destroyed/failed counts

---

## Test 32 — Clean Resources

**Purpose:** Verify `clean --resources` removes e2e/test leftovers.

```bash
assignee clean --resources --dry-run    # Preview
assignee clean --resources --yes        # Execute
```

**Check:**

- [ ] Pattern matches /e2e|test/i
- [ ] Only matching resources shown/destroyed

---

## Test 33 — VPC Networking pattern (17 resources)

**Purpose:** Verify the most complex compound pattern: VPC + 2 public subnets + 2 private subnets + IGW + NAT Gateway + route tables + routes + associations.

```bash
assignee plan "Create a VPC with public and private subnets"
```

**Check:**

- [ ] Pattern detected: "VPC with Public and Private Subnets"
- [ ] Dependency plan shows 17 resources in correct order
- [ ] VPC is first (group 0), subnets in group 1, routes in later groups
- [ ] NatGateway shows cost estimate (~$32/month)
- [ ] EIP companion resource listed

```bash
assignee apply "Create a VPC with public and private subnets" --yes
```

**Check (if applied):**

- [ ] All provisionable resources created via CloudControl
- [ ] Non-provisionable resources (EIP, VPCGatewayAttachment, SubnetRouteTableAssociations) handled correctly
- [ ] VPC has EnableDnsHostnames=true
- [ ] Public subnets have MapPublicIpOnLaunch=true
- [ ] IGW attached to VPC
- [ ] NAT Gateway in public subnet with allocated EIP

**Cleanup:**

```bash
assignee destroy --all --yes
```

---

## Test 34 — SQS Queue plan

**Purpose:** Verify SQS Queue resource type through plan pipeline.

```bash
assignee plan "Create an SQS queue named test-queue"
```

**Check:**

- [ ] Resource type: AWS::SQS::Queue
- [ ] QueueName in desiredState
- [ ] BP findings include: encryption (SqsManagedSseEnabled), dead letter queue (RedrivePolicy)
- [ ] Cost estimate shown

---

## Test 35 — SNS Topic plan

**Purpose:** Verify SNS Topic resource type.

```bash
assignee plan "Create an SNS topic named test-notifications"
```

**Check:**

- [ ] Resource type: AWS::SNS::Topic
- [ ] TopicName in desiredState
- [ ] BP findings include: KMS encryption (KmsMasterKeyId)

---

## Test 36 — DynamoDB Table plan with key schema

**Purpose:** Verify DynamoDB with partition key configuration.

```bash
assignee plan "Create a DynamoDB table named users with partition key userId"
```

**Check:**

- [ ] Resource type: AWS::DynamoDB::Table
- [ ] KeySchema includes partition key
- [ ] BP findings include: PITR, deletion protection, encryption

---

## Test 37 — EC2 Instance plan with pricing

**Purpose:** Verify EC2 instance type selection and live pricing.

```bash
assignee plan "Create an EC2 t3.micro instance"
```

**Check:**

- [ ] Resource type: AWS::EC2::Instance
- [ ] InstanceType in desiredState
- [ ] Pricing breakdown shows Compute + Storage line items
- [ ] BP findings include: IMDSv2, EBS encryption, subnet placement

---

## Test 38 — RDS DBInstance plan

**Purpose:** Verify RDS with engine selection and pricing.

```bash
assignee plan "Create a PostgreSQL RDS database"
```

**Check:**

- [ ] Resource type: AWS::RDS::DBInstance
- [ ] Engine=postgres in desiredState
- [ ] BP findings include: encryption, public access, Multi-AZ, backup retention
- [ ] Cost estimate shown (RDS is not free tier)

---

## Test 39 — ECS Cluster plan

**Purpose:** Verify ECS Cluster resource type.

```bash
assignee plan "Create an ECS cluster named test-cluster"
```

**Check:**

- [ ] Resource type: AWS::ECS::Cluster
- [ ] ClusterName in desiredState
- [ ] Cost: Free (ECS clusters are free)

---

## Test 40 — ECR Repository plan

**Purpose:** Verify ECR Repository resource type.

```bash
assignee plan "Create an ECR repository named test-images"
```

**Check:**

- [ ] Resource type: AWS::ECR::Repository
- [ ] RepositoryName in desiredState
- [ ] BP findings include: image scanning, tag immutability

---

## Test 41 — Lambda Function plan

**Purpose:** Verify Lambda with runtime and memory configuration.

```bash
assignee plan "Create a Lambda function named test-handler with nodejs20.x runtime"
```

**Check:**

- [ ] Resource type: AWS::Lambda::Function
- [ ] Runtime, Handler, MemorySize in desiredState
- [ ] BP findings include: reserved concurrency, DLQ, architecture (arm64)

---

## Test 42 — CloudWatch Alarm plan

**Purpose:** Verify CloudWatch Alarm resource type.

```bash
assignee plan "Create a CloudWatch alarm for CPU utilization above 80%"
```

**Check:**

- [ ] Resource type: AWS::CloudWatch::Alarm
- [ ] MetricName, ComparisonOperator, Threshold in desiredState
- [ ] BP findings include: AlarmActions, EvaluationPeriods

---

## Test 43 — SecretsManager Secret plan

**Purpose:** Verify SecretsManager Secret resource type.

```bash
assignee plan "Create a secret named test-api-key in Secrets Manager"
```

**Check:**

- [ ] Resource type: AWS::SecretsManager::Secret
- [ ] Name in desiredState
- [ ] BP findings include: KMS encryption, rotation schedule

---

## Test 44 — ApiGatewayV2 API plan

**Purpose:** Verify API Gateway V2 (HTTP API) resource type.

```bash
assignee plan "Create an HTTP API Gateway"
```

**Check:**

- [ ] Resource type: AWS::ApiGatewayV2::Api
- [ ] ProtocolType in desiredState
- [ ] BP findings include: access logging, CORS, authorization

---

## Test 45 — Logs LogGroup plan

**Purpose:** Verify CloudWatch Logs LogGroup resource type.

```bash
assignee plan "Create a CloudWatch log group named /app/test"
```

**Check:**

- [ ] Resource type: AWS::Logs::LogGroup
- [ ] LogGroupName in desiredState
- [ ] BP findings include: retention (auto-fixed to 14 days), KMS encryption

---

## Test 46 — SecurityGroup plan

**Purpose:** Verify EC2 Security Group resource type.

```bash
assignee plan "Create a security group for a web server allowing port 80 and 443"
```

**Check:**

- [ ] Resource type: AWS::EC2::SecurityGroup
- [ ] GroupDescription in desiredState
- [ ] BP findings include: SSH restriction, ingress rules

---

## Test 47 — VPC plan (single resource)

**Purpose:** Verify single VPC resource (not the compound pattern).

```bash
assignee plan "Create a VPC with CIDR 10.0.0.0/16"
```

**Check:**

- [ ] Resource type: AWS::EC2::VPC
- [ ] CidrBlock in desiredState
- [ ] BP findings include: DNS hostnames, flow logs

---

## Test 47a — Subnet plan

**Purpose:** Verify EC2 Subnet resource type individually.

```bash
assignee plan "Create a subnet with CIDR 10.0.1.0/24"
```

**Check:**

- [ ] Resource type: AWS::EC2::Subnet
- [ ] CidrBlock in desiredState
- [ ] Cost: Free

---

## Test 47b — Internet Gateway plan

**Purpose:** Verify EC2 Internet Gateway resource type individually.

```bash
assignee plan "Create an internet gateway"
```

**Check:**

- [ ] Resource type: AWS::EC2::InternetGateway
- [ ] Cost: Free (no charge)

---

## Test 47c — Route Table plan

**Purpose:** Verify EC2 Route Table resource type individually.

```bash
assignee plan "Create a route table"
```

**Check:**

- [ ] Resource type: AWS::EC2::RouteTable
- [ ] Cost: Free (no charge)

---

## Test 47d — Route plan

**Purpose:** Verify EC2 Route resource type individually.

```bash
assignee plan "Create a route to 0.0.0.0/0 via internet gateway"
```

**Check:**

- [ ] Resource type: AWS::EC2::Route
- [ ] DestinationCidrBlock in desiredState
- [ ] Cost: Free (no charge)

---

## Test 47e — NAT Gateway plan

**Purpose:** Verify EC2 NAT Gateway resource type with pricing.

```bash
assignee plan "Create a NAT gateway"
```

**Check:**

- [ ] Resource type: AWS::EC2::NatGateway
- [ ] Pricing breakdown shows Hourly + Data processing line items
- [ ] Cost estimate shown (NAT Gateway is NOT free)

---

## Test 47f — ELBv2 Load Balancer plan

**Purpose:** Verify ELBv2 Application Load Balancer resource type.

```bash
assignee plan "Create an application load balancer named test-alb"
```

**Check:**

- [ ] Resource type: AWS::ElasticLoadBalancingV2::LoadBalancer
- [ ] Type=application in desiredState
- [ ] Pricing breakdown shows Hourly + LCU line items
- [ ] BP findings include: access logging, deletion protection

---

## Test 48 — Static website with --source (full flow)

**Purpose:** End-to-end static website: plan -> apply -> upload -> CloudFront -> verify URL.

```bash
mkdir -p /tmp/test-site
echo '<!DOCTYPE html><html><body><h1>Test</h1></body></html>' > /tmp/test-site/index.html
echo 'body { color: blue; }' > /tmp/test-site/style.css

assignee apply "Host a static website" --source /tmp/test-site --yes
```

**Check:**

- [ ] S3 bucket created with WebsiteConfiguration (IndexDocument=index.html)
- [ ] PublicAccessBlockConfiguration all false (website needs public access)
- [ ] Files uploaded: index.html (text/html), style.css (text/css)
- [ ] Upload progress shown: "Uploading 1/2: index.html", "Uploading 2/2: style.css"
- [ ] CloudFront distribution created with OAC
- [ ] Bucket policy uses `aws:SourceArn` (lowercase) with distribution ARN
- [ ] S3 Website URL displayed: http://<bucket>.s3-website-us-east-1.amazonaws.com
- [ ] CloudFront URL displayed: https://<id>.cloudfront.net
- [ ] Status: InProgress message shown
- [ ] BP findings suppressed for static-website pattern (excludePatterns)

**Verify CloudFront works (wait 5-15 min for deployment):**

```bash
curl -sI https://<cloudfront-domain>.cloudfront.net/ | head -5
# Expect: HTTP/2 200, content-type: text/html
```

**Cleanup:**

```bash
assignee destroy --all --yes
```

---

## Test 49 — --source with single S3 bucket (no CloudFront)

**Purpose:** Verify `--source` with a plain S3 bucket does NOT create CloudFront.

```bash
assignee apply "Create an S3 bucket" --source /tmp/test-site --yes
```

**Check:**

- [ ] S3 bucket created
- [ ] Files uploaded
- [ ] Public-read bucket policy set (not OAC)
- [ ] S3 Website URL shown (HTTP only)
- [ ] NO CloudFront distribution created
- [ ] No "CloudFront" in output

**Cleanup:**

```bash
assignee destroy --all --yes
```

---

## Test 50 — Container Service pattern

**Purpose:** Verify 3-resource container pattern: ECR -> ECS Cluster -> IAM Role.

```bash
assignee plan "Create a container service"
```

**Check:**

- [ ] Pattern detected: "Container Service (ECS Fargate)"
- [ ] 3 resources in dependency plan
- [ ] ECR Repository first, then ECS Cluster + IAM Role

---

## Test 51 — Three-Tier Web pattern

**Purpose:** Verify 3-resource three-tier pattern: EC2 + RDS + SecurityGroup.

```bash
assignee plan "Create a three-tier web application"
```

**Check:**

- [ ] Pattern detected: "Three-Tier Web Application"
- [ ] 3+ resources in dependency plan
- [ ] Security group created before EC2/RDS

---

## Test 52 — Drift detection

**Purpose:** Verify drift detection for managed resources.

```bash
# First create a resource
assignee apply "Create an SSM parameter named /test/drift" --yes

# Manually modify it outside assignee
aws ssm put-parameter --name /test/drift --value "modified-externally" --overwrite

# Detect drift
assignee drift

# Reconcile
assignee reconcile
```

**Check:**

- [ ] Drift detected: shows MODIFIED field
- [ ] Desired vs actual values displayed
- [ ] Reconcile offers: restore desired / accept current / skip
- [ ] After reconcile, drift re-check shows IN_SYNC

**Cleanup:**

```bash
assignee destroy --all --yes
```

---

## Test 53 — SDK Fallback types

**Purpose:** Verify Lambda EventSourceMapping and SNS Subscription (SDK-routable, not CCAPI).

```bash
# These types are provisioned via direct AWS SDK, not CloudControl
# Test in context of serverless-api or message-processing pattern
assignee plan "Create a serverless API with Lambda and SQS trigger"
```

**Check:**

- [ ] Lambda EventSourceMapping handled via SDK fallback
- [ ] Plan shows all resources including SDK-routed ones

---

## Test 54 — Bulk destroy with all resource types

**Purpose:** Full lifecycle: create resources, list, destroy all.

```bash
# Create several resources
assignee apply "Create an SSM parameter named /test/bulk-1" --yes
assignee apply "Create an SSM parameter named /test/bulk-2" --yes
assignee apply "Create an ECS cluster named test-bulk" --yes

# List all
assignee list

# Preview destruction
assignee destroy --all --dry-run

# Destroy all
assignee destroy --all --yes

# Verify clean
assignee list
```

**Check:**

- [ ] All 3 resources listed before destroy
- [ ] Dry-run shows tier ordering (SSM=tier 1, ECS=tier 3)
- [ ] All resources destroyed successfully
- [ ] Final list shows only IAM policies (excluded by default)

---

## Smoke test checklist

Run all tests and mark pass/fail:

| #   | Test                                                                    | Result |
| --- | ----------------------------------------------------------------------- | ------ |
| 1   | `plan` renders box in <3s                                               | ⬜     |
| 2   | `apply` + approve → S3 bucket created with 3 tags                       | ⬜     |
| 3   | `apply` + decline → exits 0, no resource                                | ⬜     |
| 4   | State Guard — second apply aborts with "Stale Plan"                     | ⬜     |
| 5   | Unsupported type → actionable error with all 15 supported types         | ⬜     |
| 6   | SSM Parameter provisioning                                              | ⬜     |
| 7   | IAM Role provisioning, cost shows Free                                  | ⬜     |
| 8   | Non-TTY / pipe → no ANSI codes                                          | ⬜     |
| 9   | S3 option elicitation — prompts for BucketName, encryption, versioning  | ⬜     |
| 10  | EC2 option elicitation — InstanceType enum with live $/hr prices        | ⬜     |
| 11  | RDS option elicitation — DBInstanceClass enum with live $/hr prices     | ⬜     |
| 12  | Option elicitation — CI mode (non-TTY) skips all prompts                | ⬜     |
| 13  | Compound plan — `create a serverless api` shows IAM Role plan box       | ⬜     |
| 14  | Compound apply — `deploy a static website` → S3 + compound success box  | ⬜     |
| 15  | Compound apply — message processing → partial failure + cleanup warning | ⬜     |
| 16  | Compound apply — full success (5 resources) with valid Lambda zip       | ⬜     |
| 17  | Prompt injection — null bytes, `${`, unicode overrides stripped safely  | ⬜     |
| 18  | Credential fail-fast — invalid creds error in <5s                       | ⬜     |
| 19  | Lambda Function single-resource plan with elicitation                   | ⬜     |
| 20  | DynamoDB Table single-resource plan                                     | ⬜     |
| 21  | Pattern detection logged — no Bedrock call for compound intents         | ⬜     |
| 22  | `assignee list` — shows managed resources                               | ⬜     |
| 23  | `assignee destroy` — safe teardown with "yes" confirmation              | ⬜     |
| 24  | `assignee status` — summary with cost totals                            | ⬜     |
| 25  | `assignee init` — project setup                                         | ⬜     |
| 26  | `assignee plan --no-wizard` — non-interactive plan                      | ⬜     |
| 27  | `assignee apply --yes --checkpoint` — CI mode auto-confirm              | ⬜     |
| 28  | Best practices findings in plan output                                  | ⬜     |
| 29  | Memory hints ("Previous provision: $X/month") in plan output            | ⬜     |
| 30  | Static Website Deploy — S3 + CloudFront + file upload via `--source`    | ⬜     |
| 31  | Bulk Destroy — `destroy --all` with tier ordering and IAM exclusion     | ⬜     |
| 32  | Clean Resources — `clean --resources` removes e2e/test leftovers        | ⬜     |
| 33  | VPC Networking pattern — 17 resources, dependency ordering, NAT+EIP     | ⬜     |
| 34  | SQS Queue plan — encryption + DLQ best practices                        | ⬜     |
| 35  | SNS Topic plan — KMS encryption best practice                           | ⬜     |
| 36  | DynamoDB Table plan — key schema, PITR, deletion protection             | ⬜     |
| 37  | EC2 Instance plan — instance type, pricing breakdown, IMDSv2            | ⬜     |
| 38  | RDS DBInstance plan — engine selection, encryption, Multi-AZ            | ⬜     |
| 39  | ECS Cluster plan — free cost estimate                                   | ⬜     |
| 40  | ECR Repository plan — image scanning, tag immutability                  | ⬜     |
| 41  | Lambda Function plan — runtime, memory, DLQ, arm64                      | ⬜     |
| 42  | CloudWatch Alarm plan — metric, threshold, alarm actions                | ⬜     |
| 43  | SecretsManager Secret plan — KMS, rotation schedule                     | ⬜     |
| 44  | ApiGatewayV2 API plan — access logging, CORS, authorization             | ⬜     |
| 45  | Logs LogGroup plan — retention auto-fix, KMS encryption                 | ⬜     |
| 46  | SecurityGroup plan — SSH restriction, ingress rules                     | ⬜     |
| 47  | VPC plan (single) — CIDR, DNS hostnames, flow logs                      | ⬜     |
| 48  | Static website --source — S3 + CloudFront + file upload E2E             | ⬜     |
| 49  | --source single S3 — no CloudFront, public-read policy                  | ⬜     |
| 50  | Container Service pattern — ECR + ECS + IAM                             | ⬜     |
| 51  | Three-Tier Web pattern — EC2 + RDS + SecurityGroup                      | ⬜     |
| 52  | Drift detection — detect + reconcile flow                               | ⬜     |
| 53  | SDK Fallback types — EventSourceMapping, SNS Subscription               | ⬜     |
| 54  | Bulk destroy all types — create, list, dry-run, destroy, verify         | ⬜     |

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
Tests 53 passing = SDK fallback provisioning verified.
Tests 54 passing = Full lifecycle bulk operations verified.
