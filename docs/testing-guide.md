# Testing Guide — Assignee.ai POC

> End-to-end smoke tests for the `assignee plan` and `assignee apply` commands.
> All tests run against real AWS (eu-west-1, account 054125018476).

---

## Prerequisites

```bash
# 1. Install dependencies and build
cd /Users/serhii_l/code/GenAi/assignee.ai
pnpm install
pnpm build

# 2. Verify .env is populated
cat .env
# Must contain: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_REGION,
#               MCP_AWS_ACCESS_KEY_ID, MCP_AWS_SECRET_ACCESS_KEY

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

> ⚠️ This creates a real S3 bucket in `eu-west-1`. Clean up afterwards.

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
  --region eu-west-1
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

> Bedrock runs in `us-east-1` (`AWS_REGION` in `.env`) — logs are written there, not in `eu-west-1`. `--output text --query 'events[0].message'` returns the literal string `None` when no events match (breaking `jq`); use `--output json` and extract via jq instead.

**Check:**

- [ ] Resource created and visible in AWS Console → S3
- [ ] All 3 mandatory tags present (`managed-by`, `assignee-run-id`, `environment`)
- [ ] ARN printed to terminal
- [ ] Exits 0: `echo $?` → `0`
- [ ] Bedrock invocation visible in CloudWatch log group

**Cleanup:**

```bash
aws s3 rb s3://$BUCKET --region eu-west-1
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
aws s3 rb s3://$BUCKET --region eu-west-1
```

---

## Test 5 — Unsupported resource type

**Purpose:** Verify intent parser rejects unsupported types with an actionable error (NFR-08).

```bash
assignee plan "Create an EC2 instance with 2 CPUs"
```

**Expected:**

```
✖ Error: Unsupported resource type: AWS::EC2::Instance
  How to Fix: Supported in POC: AWS::S3::Bucket, AWS::SSM::Parameter, AWS::IAM::Role
```

**Check:**

- [ ] Exits 1: `echo $?` → `1`
- [ ] Error lists all 3 supported POC types
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
  --region eu-west-1 \
  --query 'Parameter.Value' \
  --output text
# Expected: hello-world
```

**Cleanup:**

```bash
aws ssm delete-parameter --name /poc/test/greeting --region eu-west-1
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
# Confirm no ANSI codes (macOS-compatible — BSD grep does not support -P)
assignee plan "Create an S3 bucket named poc-ci-test" | cat | grep $'\033[' && echo "FAIL: ANSI found" || echo "PASS: no ANSI"
```

---

## Smoke test checklist

Run all tests and mark pass/fail:

| #   | Test                                                          | Result |
| --- | ------------------------------------------------------------- | ------ |
| 1   | `plan` renders box in <3s                                     | ⬜     |
| 2   | `apply` + approve → S3 bucket created with 3 tags             | ⬜     |
| 3   | `apply` + decline → exits 0, no resource                      | ⬜     |
| 4   | State Guard — second apply aborts with "Stale Plan"           | ⬜     |
| 5   | Unsupported type → actionable error with supported types list | ⬜     |
| 6   | SSM Parameter provisioning                                    | ⬜     |
| 7   | IAM Role provisioning, cost shows Free                        | ⬜     |
| 8   | Non-TTY / pipe → no ANSI codes                                | ⬜     |

All 8 passing = POC demo-ready. ✅
