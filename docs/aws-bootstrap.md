---
diataxis: how-to
canonical: true
---

> **Diátaxis: How-to** — This is the canonical root page for this topic. Task-oriented guide for setting up AWS credentials and IAM users.

# AWS Bootstrap Guide

> Stories covered: **0.5** (account bootstrap) · **2.5** (IAM tightening) · **18.8** (IAM security overhaul)
>
> Account: `123456789012` (example — replace with your account ID) · Region: `us-east-1`

---

## Quick Setup (Recommended)

The `assignee setup` command automates IAM user and policy creation. Run it once with admin/root credentials:

```bash
# Build the CLI (if not already built)
pnpm build

# Run the setup wizard — creates 3 IAM users with least-privilege policies
assignee setup
```

This creates:

- **assignee-operator** — Bedrock + CloudControl provisioning (operator-level)
- **assignee-reader** — CloudFormation schema, Pricing, Cost Explorer (read-only)
- **assignee-auditor** — IAM simulate, SecurityHub, GuardDuty, Inspector (read-only)

Access keys are written to `.env` automatically. If `ASSIGNEE_OPERATOR_SESSION_TOKEN`
is already set in the environment, `assignee setup` forwards it alongside the
access key pair — useful for short-lived STS or assumed-role credentials.
The command is idempotent — safe to re-run.

### SSO / named profile alternative

If your team uses AWS SSO, you can skip the IAM-user setup entirely by
initialising with a named profile:

```bash
aws sso login --profile my-sso-profile
assignee init --profile my-sso-profile
```

The `--profile` flag on `assignee init` sets `AWS_PROFILE` for all
subsequent CLI invocations. Credentials are resolved lazily from the SSO
token cache — no long-lived access keys are stored in `.env`. See
[how-to/sso-authentication.md](how-to/sso-authentication.md) for the
full SSO walk-through.

> **Existing users:** re-run `assignee setup` to pick up Wave 19/20 IAM updates
> (`s3:ListBucketVersions`, `s3:DeleteObjectVersion`, `ec2:DescribeAddresses`,
> `iam:GetPolicy`) and the (f) 2026-04-09 A/B policy split. The operator user
> now attaches three managed policies:
>
> - `AssigneeOperatorPolicy` (core Bedrock + CloudControl + tagging)
> - `AssigneeOperatorServicesAPolicy` (service-specific actions A-half)
> - `AssigneeOperatorServicesBPolicy` (service-specific actions B-half)
>
> Without these, S3 destroy on versioned buckets, NAT Gateway EIP-reuse, and
> the managed-policy-ARN preflight will silently fall back to less-safe paths.

> **Policies are generated from code** by `packages/core/src/config/iam-policies/` (directory with per-role generators at `operator.ts` / `reader.ts` / `auditor.ts` behind the `index.ts` barrel).
> They derive permissions from `SUPPORTED_TYPES_ARRAY` and `getRequiredIamActions()`.
> Do not edit IAM policies manually — update the code instead.

---

## Prerequisites

- AWS CLI v2 (`aws --version`)
- Admin credentials (root or IAM admin) — needed for IAM and Bedrock logging setup
- Region: **us-east-1** for all resource creation

---

## Task 1 — IAM Role for Bedrock Logging

> **Automated:** Tasks 1–3 are now handled by `assignee setup`. The manual steps below are kept for reference only.

Creates the IAM role that Bedrock assumes to write invocation logs to CloudWatch.

```bash
# Create role with Bedrock as trusted principal
aws --region us-east-1 iam create-role \
  --role-name AssigneeAiBedrockLoggingRole \
  --assume-role-policy-document '{
  "Version":"2012-10-17",
  "Statement":[{
    "Effect":"Allow",
    "Principal":{"Service":"bedrock.amazonaws.com"},
    "Action":"sts:AssumeRole"
  }]
}' \
  --description "Allows Bedrock to write invocation logs to CloudWatch"

# Attach permissions to write to the log group
aws --region us-east-1 iam put-role-policy \
  --role-name AssigneeAiBedrockLoggingRole \
  --policy-name BedrockLoggingPolicy \
  --policy-document '{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Action": [
      "logs:CreateLogGroup",
      "logs:CreateLogStream",
      "logs:PutLogEvents",
      "logs:DescribeLogGroups"
    ],
    "Resource": "arn:aws:logs:us-east-1:123456789012:log-group:/assignee-ai/bedrock-invocations:*"
  }]
}'
```

---

## Task 2 — CloudWatch Log Group

> **Automated:** See Task 1 note above.

```bash
aws --region us-east-1 logs create-log-group \
  --log-group-name /assignee-ai/bedrock-invocations
```

---

## Task 3 — Enable Bedrock Invocation Logging (Story 0.5 AC1, AC3)

> **Automated:** See Task 1 note above.

```bash
aws --region us-east-1 bedrock put-model-invocation-logging-configuration \
  --logging-config '{
  "cloudWatchConfig": {
    "logGroupName": "/assignee-ai/bedrock-invocations",
    "roleArn": "arn:aws:iam::123456789012:role/AssigneeAiBedrockLoggingRole"
  },
  "textDataDeliveryEnabled": true,
  "imageDataDeliveryEnabled": false,
  "embeddingDataDeliveryEnabled": false
}'

# Verify
aws --region us-east-1 bedrock get-model-invocation-logging-configuration
```

---

## Task 4 — IAM Users and Policies (automated by `assignee setup`)

The 3 IAM users and their policies are created automatically by `assignee setup`.
Policies are generated by `packages/core/src/config/iam-policies/` — do not edit manually.

**Manual alternative (CLI):**

If you prefer to create the users manually, generate the policy JSON from the code:

```bash
# Print generated policy documents (for reference)
node -e "
  const { operatorPolicy, readerPolicy, auditorPolicy } = require('@assignee/core');
  console.log('Operator:', JSON.stringify(operatorPolicy(), null, 2));
  console.log('Reader:', JSON.stringify(readerPolicy(), null, 2));
  console.log('Auditor:', JSON.stringify(auditorPolicy(), null, 2));
"
```

Then create users and attach the policies using `aws iam create-user`, `aws iam create-policy`, and `aws iam attach-user-policy`.

---

## Task 5 — Set GitHub Actions Secret (Story 0.5 AC5)

```bash
gh secret set BEDROCK_LOGGING_VERIFIED --body "true"
```

---

## Completion Checklist

- [x] `AssigneeAiBedrockLoggingRole` IAM role created with CloudWatch write permissions
- [x] CloudWatch log group `/assignee-ai/bedrock-invocations` created in `us-east-1`
- [x] Bedrock invocation logging enabled
- [x] 3 IAM users created via `assignee setup`: `assignee-operator`, `assignee-reader`, `assignee-auditor`
- [x] Managed policies attached: `AssigneeOperatorPolicy`, `AssigneeReaderPolicy`, `AssigneeAuditorPolicy`
- [x] Access keys written to `.env`
- [ ] `BEDROCK_LOGGING_VERIFIED=true` secret set in GitHub Actions

---

## IAM Users Summary

| User                | Purpose                                          | Policy                   | Trust Level | Env Vars              |
| ------------------- | ------------------------------------------------ | ------------------------ | ----------- | --------------------- |
| `assignee-operator` | Bedrock + CloudControl provisioning              | `AssigneeOperatorPolicy` | Highest     | `ASSIGNEE_OPERATOR_*` |
| `assignee-reader`   | Schema, pricing, billing (read-only)             | `AssigneeReaderPolicy`   | Read-only   | `ASSIGNEE_READER_*`   |
| `assignee-auditor`  | IAM simulate, SecurityHub, GuardDuty (read-only) | `AssigneeAuditorPolicy`  | Read-only   | `ASSIGNEE_AUDITOR_*`  |

## AWS Resources Created

| Resource                           | Type                 | Region    |
| ---------------------------------- | -------------------- | --------- |
| `AssigneeAiBedrockLoggingRole`     | IAM Role             | global    |
| `/assignee-ai/bedrock-invocations` | CloudWatch Log Group | us-east-1 |
| Bedrock invocation logging config  | Account-level        | us-east-1 |
| `assignee-operator`                | IAM User             | global    |
| `assignee-reader`                  | IAM User             | global    |
| `assignee-auditor`                 | IAM User             | global    |

---

---

## Partition support

Assignee detects the active AWS partition from the caller-identity ARN
(`arn:aws:…` vs `arn:aws-cn:…` vs `arn:aws-us-gov:…`, etc.) and adjusts
provisioning accordingly.

| Partition       | S3, IAM, VPC provisioning | Other resource types                |
| --------------- | ------------------------- | ----------------------------------- |
| `aws` (default) | CloudControl API          | CloudControl API                    |
| `aws-cn`        | SDK-direct fallback       | "Not supported in aws-cn" error     |
| `aws-us-gov`    | SDK-direct fallback       | "Not supported in aws-us-gov" error |
| `aws-iso*`      | SDK-direct fallback       | "Not supported in aws-iso\*" error  |

**GovCloud / China / ISO operators:** S3, IAM Role, and VPC resources
provisioned in non-commercial partitions use SDK-direct paths (not the
CloudControl API). All other resource types emit an actionable error at
provision time explaining which partition they are in and what is
currently unsupported. Submit a feature request if you need additional
types in your partition.

**ARN detection:** Assignee uses the pattern `/^arn:aws[\w-]*:/` (not
the literal `arn:aws:`) to correctly identify ARNs across all partitions,
including GovCloud (`aws-us-gov`) and China (`aws-cn`).

---

## References

- NFR-10: All Bedrock invocations must be logged for auditability
- NFR-13: No wildcard IAM permissions
- NFR-14: All provisioned resources must carry mandatory traceability tags
