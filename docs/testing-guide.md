# Testing Guide — Assignee.ai CLI-First MVP

> Unit tests (Vitest) and end-to-end smoke tests for the `assignee plan`, `assignee apply`, `assignee list`, `assignee destroy`, `assignee status`, and `assignee init` commands.

---

## Unit tests

```bash
pnpm test          # 808 tests across 52 files (724 CLI + 84 MCP)
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
  createCoreMockTools,
  createIamMockTool,
  createSecurityMockTool,
  createBillingMockTool,
} from "../test-fixtures/mcp-mock-responses.js";

// Single mock tool
const tool = createMockTool(
  ToolName.GET_RESOURCE_SCHEMA,
  McpMocks.schema.s3Bucket.success,
);

// Pre-built tool sets
const tools = createCoreMockTools(
  McpMocks.schema.ec2Instance.success,
  McpMocks.pricing.ec2T3Micro.success,
);

// Domain-specific mock tools
const iamTool = createIamMockTool(McpMocks.iam.s3BucketAllowed);
const secTool = createSecurityMockTool(McpMocks.security.s3BucketPosture);
const billTool = createBillingMockTool(McpMocks.billing.s3BucketCost);
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

| File                             | Tests | What it covers                                                                       |
| -------------------------------- | ----- | ------------------------------------------------------------------------------------ |
| `graph-integration.test.ts`      | 18    | Full graph pipeline: S3, EC2, Lambda, IAM, DynamoDB, error paths, pricing edge cases |
| `preflight-guard.test.ts`        | 10    | Required field validation, cost estimation, pricing timeout                          |
| `intent-parser.test.ts`          | 11    | Resource type classification, compound pattern detection                             |
| `schema-fetcher.test.ts`         | 7     | MCP schema retrieval, error handling                                                 |
| `option-elicitor.test.ts`        | 24    | Interactive prompts, showIf conditionals, CI mode                                    |
| `plan-generator.test.ts`         | 8     | LLM plan generation, JSON parsing                                                    |
| `pricing-lookup.test.ts`         | 17    | EC2/RDS live price enrichment                                                        |
| `result-formatter.test.ts`       | ~30   | Memory writes, security checks, output formatting                                    |
| `status-poller.test.ts`          | —     | CloudControl status polling, timeout handling                                        |
| `destroy.test.ts`                | 14    | Safe teardown, confirmation prompts, error paths                                     |
| `list.test.ts`                   | 7     | Managed resource listing, filtering                                                  |
| `status.test.ts`                 | 4     | Summary with cost totals                                                             |
| `resource-resolver.test.ts`      | 7     | Resource type resolution, ARN parsing                                                |
| `list-resources.test.ts`         | 14    | Resource enumeration, tag-based filtering                                            |
| `billing.test.ts`                | 11    | Cost data retrieval, forecast, multi-resource aggregation                            |
| `status-aggregator.test.ts`      | 19    | Status rollup across multiple resources                                              |
| `memory.test.ts` (service)       | —     | Memory service read/write, hint retrieval                                            |
| `memory.test.ts` (core schema)   | —     | Memory schema validation                                                             |
| `iam-actions.test.ts`            | 6     | IAM action resolution, permission checks                                             |
| `distribution.test.ts`           | —     | CLI + MCP server distribution packaging                                              |
| `mcp-servers.test.ts`            | 6     | MCP server config loading, lifecycle                                                 |
| `server.test.ts` (MCP)           | —     | MCP server startup, tool registration                                                |
| `plan-resource.test.ts` (MCP)    | —     | MCP plan-resource tool handler                                                       |
| `apply-plan.test.ts` (MCP)       | —     | MCP apply-plan tool handler                                                          |
| `list-managed-resources.test.ts` | —     | MCP list-managed-resources tool handler                                              |
| `estimate-cost.test.ts` (MCP)    | —     | MCP estimate-cost tool handler                                                       |
| Plugin tests (core)              | 50+   | S3, EC2, RDS, Lambda, generic plugin config hints                                    |

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

**Structured logs check** (stderr):

```bash
assignee plan "Create an S3 bucket named poc-smoke-test" 2>/tmp/assignee-logs.txt 1>/dev/null; jq . /tmp/assignee-logs.txt
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

Tests 1–8 passing = Core demo-ready.
Tests 9–12 passing = Option elicitation (Story 7.3) verified.
Tests 13–16 passing = Compound provisioning (Story 8.2) verified.
Tests 17–18 passing = Architecture hardening (Epic 9) verified.
Tests 19–21 passing = Expanded resource types + pattern logging verified.
Tests 22–25 passing = Utility commands (list, destroy, status, init) verified.
Tests 26–27 passing = CI/non-interactive mode verified.
Tests 28–29 passing = Best practices + memory integration verified.
