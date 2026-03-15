# AWS Bootstrap Guide — Human Operator Checklist

> **⚠️ This guide is for human operators only.** These tasks cannot be automated by a dev agent.
> Complete all steps before running Assignee.ai against a real AWS account.
>
> Stories covered: **0.5** (account bootstrap) · **2.5** (IAM tightening)

---

## Prerequisites

- AWS CLI v2 installed and configured (`aws --version`)
- Credentials for an IAM identity with admin or power-user permissions
- Access to the GitHub repository settings (for secrets)
- Region: **eu-west-1** (all resources scoped to this region)

---

## Task 1 — Enable Bedrock Model Invocation Logging (Story 0.5 AC1, AC3)

Bedrock invocation logging captures every model call to CloudWatch for auditability (NFR-10).

### Steps

1. Open **AWS Console → Amazon Bedrock → Settings → Model invocation logging**
2. Click **Edit** (or **Enable logging**)
3. Set:
   - **Log destination**: CloudWatch Logs
   - **Log group name**: `/assignee-ai/bedrock-invocations`
   - **IAM role**: Create or select a role with the following permissions on that log group:
     ```json
     {
       "Effect": "Allow",
       "Action": [
         "logs:CreateLogGroup",
         "logs:CreateLogStream",
         "logs:PutLogEvents",
         "logs:DescribeLogGroups"
       ],
       "Resource": "arn:aws:logs:eu-west-1:*:log-group:/assignee-ai/bedrock-invocations:*"
     }
     ```
4. Save changes.

### Verification

```bash
aws bedrock get-model-invocation-logging-configuration --output json
```

Expected: non-empty JSON containing `"cloudWatchConfig"` with the log group name. Example:

```json
{
  "loggingConfig": {
    "cloudWatchConfig": {
      "logGroupName": "/assignee-ai/bedrock-invocations",
      "roleArn": "arn:aws:iam::123456789012:role/BedrockLoggingRole"
    },
    "textDataDeliveryEnabled": true,
    "imageDataDeliveryEnabled": false
  }
}
```

---

## Task 2 — Apply IAM Least-Privilege Policy (Story 0.5 AC2 · Story 2.5 AC1, AC2)

Two IAM policies are required. Apply the tighter **Story 2.5** policy (`AssigneeAiPocPolicy`) — it supersedes the broader Story 0.5 bootstrap policy.

### Policy: `AssigneeAiPocPolicy`

Apply as an inline policy on `BedrockDevUser` (or your dev IAM role):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "BedrockInvokeNovaScopedOnly",
      "Effect": "Allow",
      "Action": ["bedrock:InvokeModel"],
      "Resource": "arn:aws:bedrock:*::foundation-model/amazon.nova-lite-v1:0"
    },
    {
      "Sid": "CloudControlScopedToSupportedTypes",
      "Effect": "Allow",
      "Action": [
        "cloudcontrol:CreateResource",
        "cloudcontrol:GetResourceRequestStatus",
        "cloudcontrol:GetResource"
      ],
      "Resource": "*",
      "Condition": {
        "StringEquals": {
          "cloudcontrol:TypeName": [
            "AWS::S3::Bucket",
            "AWS::SSM::Parameter",
            "AWS::IAM::Role"
          ]
        }
      }
    },
    {
      "Sid": "XRayTracing",
      "Effect": "Allow",
      "Action": ["xray:PutTraceSegments", "xray:PutTelemetryRecords"],
      "Resource": "*"
    }
  ]
}
```

### Apply via CLI

```bash
aws iam put-user-policy \
  --user-name BedrockDevUser \
  --policy-name AssigneeAiPocPolicy \
  --policy-document file://assignee-ai-poc-policy.json
```

### Verification

```bash
# Confirm policy is attached
aws iam get-user-policy \
  --user-name BedrockDevUser \
  --policy-name AssigneeAiPocPolicy

# Confirm unsupported types are denied (must return AccessDenied)
aws cloudcontrol create-resource \
  --type-name AWS::EC2::VPC \
  --desired-state '{"CidrBlock":"10.0.0.0/16"}'
# Expected: An error occurred (AccessDeniedException) ...
```

> **No wildcard `bedrock:*` or `cloudcontrol:*` is permitted** (NFR-13). The policy above scopes Bedrock to Nova Lite only and Cloud Control to 3 POC resource types.

---

## Task 3 — Configure Default Resource Tag Policy (Story 0.5 AC4)

Set account-level tag defaults so all resources provisioned via Assignee.ai carry governance tags even if the CLI call omits them.

### Steps

1. Open **AWS Console → AWS Organizations → Tag policies** (requires Organizations enabled)
2. Create a tag policy enforcing:
   - `environment` → value must be `poc` for resources tagged by Assignee.ai
   - `managed-by` → value must be `assignee-ai`
3. Attach the tag policy to your development account.

> **Note:** The Assignee.ai CLI also injects these tags programmatically via `injectMandatoryTags()` before every CCAPI call (NFR-14). The account tag policy is a belt-and-suspenders backstop.

---

## Task 4 — Set GitHub Actions Secret (Story 0.5 AC5)

CI gates the Bedrock logging check (Story 1.5) on this secret being present.

### Steps

1. Open **GitHub repo → Settings → Secrets and variables → Actions**
2. Click **New repository secret**
3. Name: `BEDROCK_LOGGING_VERIFIED`
   Value: `true`
4. Save.

### Verification

After adding the secret, trigger a CI run and confirm the Bedrock logging check step passes (it will be skipped/green if the secret is absent in forks, but must pass in the main repo).

---

## Completion Checklist

Mark each item complete before starting sprint development:

- [ ] Bedrock Model Invocation Logging enabled → log group `/assignee-ai/bedrock-invocations` confirmed
- [ ] `aws bedrock get-model-invocation-logging-configuration` returns non-empty JSON
- [ ] `AssigneeAiPocPolicy` inline policy attached to dev IAM identity
- [ ] `aws iam get-user-policy --user-name BedrockDevUser --policy-name AssigneeAiPocPolicy` returns policy JSON
- [ ] AWS::EC2::VPC creation attempt returns `AccessDeniedException` (scope check)
- [ ] Account tag policy configured with `environment=poc` and `managed-by=assignee-ai` defaults
- [ ] `BEDROCK_LOGGING_VERIFIED=true` secret set in GitHub Actions

---

## Why These Steps Cannot Be Automated

- **Bedrock logging**: Requires AWS Console interaction or CloudFormation (out of scope for POC). API-only enablement requires admin credentials that CI must not hold.
- **IAM policy attachment**: Requires root/admin credentials. CI credentials are intentionally least-privilege and cannot self-modify IAM.
- **GitHub secret**: Must be set by a human with repo admin access — cannot be scripted without a personal access token, which is a security antipattern.
- **One-time bootstrap**: These are account-level, environment-level settings — not repeatable per-run tasks.

---

## References

- Story 0.5 spec: `_bmad-output/implementation-artifacts/0-5-aws-account-bootstrap-and-bedrock-logging-setup.md`
- Story 2.5 spec: `_bmad-output/implementation-artifacts/2-5-implement-iam-least-privilege-policy-and-mandatory-resource-tagging.md`
- NFR-10: All Bedrock invocations must be logged for auditability
- NFR-13: No wildcard IAM permissions
- NFR-14: All provisioned resources must carry mandatory traceability tags
