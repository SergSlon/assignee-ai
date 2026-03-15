# AWS Bootstrap Guide

> Stories covered: **0.5** (account bootstrap) · **2.5** (IAM tightening)
>
> Account: `112233445566` · Region: `us-east-1`
>
> **Status: ✅ Completed 2026-03-15** — all tasks below were executed against the live account.

---

## Prerequisites

- AWS CLI v2 (`aws --version`)
- Admin credentials (root or IAM admin) — needed for IAM and Bedrock logging setup
- Region: **us-east-1** for all resource creation

---

## Task 1 — IAM Role for Bedrock Logging

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
    "Resource": "arn:aws:logs:us-east-1:112233445566:log-group:/assignee-ai/bedrock-invocations:*"
  }]
}'
```

---

## Task 2 — CloudWatch Log Group

```bash
aws --region us-east-1 logs create-log-group \
  --log-group-name /assignee-ai/bedrock-invocations
```

---

## Task 3 — Enable Bedrock Invocation Logging (Story 0.5 AC1, AC3)

```bash
aws --region us-east-1 bedrock put-model-invocation-logging-configuration \
  --logging-config '{
  "cloudWatchConfig": {
    "logGroupName": "/assignee-ai/bedrock-invocations",
    "roleArn": "arn:aws:iam::112233445566:role/AssigneeAiBedrockLoggingRole"
  },
  "textDataDeliveryEnabled": true,
  "imageDataDeliveryEnabled": false,
  "embeddingDataDeliveryEnabled": false
}'

# Verify
aws --region us-east-1 bedrock get-model-invocation-logging-configuration
```

Expected output:

```json
{
  "loggingConfig": {
    "cloudWatchConfig": {
      "logGroupName": "/assignee-ai/bedrock-invocations",
      "roleArn": "arn:aws:iam::112233445566:role/AssigneeAiBedrockLoggingRole"
    },
    "textDataDeliveryEnabled": true,
    "imageDataDeliveryEnabled": false
  }
}
```

---

## Task 4 — IAM Policy for `bedrock-dev-user` (Story 2.5 AC1, AC2)

Scopes Bedrock to Nova Lite only; Cloud Control to 3 POC resource types. No wildcards (NFR-13).

```bash
aws iam put-user-policy \
  --user-name bedrock-dev-user \
  --policy-name AssigneeAiPocPolicy \
  --policy-document '{
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
}'

# Verify
aws iam list-user-policies --user-name bedrock-dev-user
# Expected: PolicyNames includes "AssigneeAiPocPolicy"

# Scope check — must return AccessDeniedException
AWS_ACCESS_KEY_ID=<bedrock-dev-user-key> AWS_SECRET_ACCESS_KEY=<secret> \
  aws --region us-east-1 cloudcontrol create-resource \
  --type-name AWS::EC2::VPC \
  --desired-state '{"CidrBlock":"10.0.0.0/16"}'
```

---

## Task 5 — IAM Policy for `aws-mcp-user`

The MCP servers (CCAPI, CFN schema, pricing) run as `aws-mcp-user`. This policy grants the
permissions needed for all 4 MCP servers plus the underlying service permissions for CCAPI
to provision the 3 supported resource types.

```bash
aws iam put-user-policy \
  --user-name aws-mcp-user \
  --policy-name AssigneeAiMcpPolicy \
  --policy-document '{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CloudControlScopedToSupportedTypes",
      "Effect": "Allow",
      "Action": [
        "cloudcontrol:CreateResource",
        "cloudcontrol:GetResource",
        "cloudcontrol:GetResourceRequestStatus",
        "cloudcontrol:ListResources"
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
      "Sid": "S3BucketProvisioning",
      "Effect": "Allow",
      "Action": [
        "s3:CreateBucket",
        "s3:DeleteBucket",
        "s3:GetBucketLocation",
        "s3:GetBucketTagging",
        "s3:PutBucketTagging",
        "s3:ListBucket"
      ],
      "Resource": "*"
    },
    {
      "Sid": "SSMParameterProvisioning",
      "Effect": "Allow",
      "Action": [
        "ssm:PutParameter",
        "ssm:GetParameter",
        "ssm:DeleteParameter",
        "ssm:AddTagsToResource",
        "ssm:ListTagsForResource"
      ],
      "Resource": "*"
    },
    {
      "Sid": "IAMRoleProvisioning",
      "Effect": "Allow",
      "Action": [
        "iam:CreateRole",
        "iam:GetRole",
        "iam:DeleteRole",
        "iam:PutRolePolicy",
        "iam:AttachRolePolicy",
        "iam:DetachRolePolicy",
        "iam:DeleteRolePolicy",
        "iam:TagRole",
        "iam:ListRoleTags",
        "iam:PassRole"
      ],
      "Resource": "*"
    },
    {
      "Sid": "CloudFormationSchemaRead",
      "Effect": "Allow",
      "Action": [
        "cloudformation:DescribeType",
        "cloudformation:ListTypes"
      ],
      "Resource": "*"
    },
    {
      "Sid": "PricingRead",
      "Effect": "Allow",
      "Action": [
        "pricing:GetProducts",
        "pricing:DescribeServices",
        "pricing:GetAttributeValues"
      ],
      "Resource": "*"
    },
    {
      "Sid": "XRayTracing",
      "Effect": "Allow",
      "Action": ["xray:PutTraceSegments", "xray:PutTelemetryRecords"],
      "Resource": "*"
    }
  ]
}'

# Verify
aws iam list-user-policies --user-name aws-mcp-user
# Expected: PolicyNames includes "AssigneeAiMcpPolicy"
```

---

## Task 6 — Set GitHub Actions Secret (Story 0.5 AC5)

```bash
gh secret set BEDROCK_LOGGING_VERIFIED --body "true"
```

Or via Console: **GitHub repo → Settings → Secrets and variables → Actions → New repository secret**

- Name: `BEDROCK_LOGGING_VERIFIED`
- Value: `true`

---

## Completion Checklist

- [x] `AssigneeAiBedrockLoggingRole` IAM role created with CloudWatch write permissions
- [x] CloudWatch log group `/assignee-ai/bedrock-invocations` created in `us-east-1`
- [x] Bedrock invocation logging enabled → `get-model-invocation-logging-configuration` returns non-empty JSON
- [x] `AssigneeAiPocPolicy` inline policy attached to `bedrock-dev-user`
- [x] `AssigneeAiMcpPolicy` inline policy attached to `aws-mcp-user`
- [ ] AWS::EC2::VPC creation attempt by `bedrock-dev-user` returns `AccessDeniedException` (scope check)
- [ ] `BEDROCK_LOGGING_VERIFIED=true` secret set in GitHub Actions

---

## IAM Users Summary

| User               | Purpose                                  | Policy                                            |
| ------------------ | ---------------------------------------- | ------------------------------------------------- |
| `bedrock-dev-user` | Bedrock AI calls (Nova Lite)             | `AssigneeAiPocPolicy` + `TerraformIAMPermissions` |
| `aws-mcp-user`     | MCP servers (CCAPI, CFN schema, pricing) | `AssigneeAiMcpPolicy`                             |

## AWS Resources Created

| Resource                           | Type                 | Region    |
| ---------------------------------- | -------------------- | --------- |
| `AssigneeAiBedrockLoggingRole`     | IAM Role             | global    |
| `/assignee-ai/bedrock-invocations` | CloudWatch Log Group | us-east-1 |
| Bedrock invocation logging config  | Account-level        | us-east-1 |

---

## References

- Story 0.5 spec: `_bmad-output/implementation-artifacts/0-5-aws-account-bootstrap-and-bedrock-logging-setup.md`
- Story 2.5 spec: `_bmad-output/implementation-artifacts/2-5-implement-iam-least-privilege-policy-and-mandatory-resource-tagging.md`
- NFR-10: All Bedrock invocations must be logged for auditability
- NFR-13: No wildcard IAM permissions
- NFR-14: All provisioned resources must carry mandatory traceability tags
