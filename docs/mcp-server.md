# MCP Server

Expose assignee.ai as [Model Context Protocol](https://modelcontextprotocol.io/) tools so AI-powered IDEs can plan, estimate, provision, and destroy AWS infrastructure through natural conversation.

## What This Does

The MCP server wraps the same 14-node LangGraph pipeline that powers the CLI into 5 MCP tools. Any MCP-compatible client (Cursor, Claude Code, Windsurf, etc.) can call these tools to manage AWS resources without leaving the editor.

## Prerequisites

- Node.js >= 20
- AWS credentials configured (same credential chain as the CLI -- see [Quickstart](./how-to/quickstart.md#prerequisites))
- Amazon Bedrock access in your region
- A source build of the repo (see Install section below)

## Install (source build required — v0.2 npm publish pending)

> **Pre-release notice:** `@assignee/mcp-server` is `private: true` — it is not yet published to npm. The `npx -y assignee-mcp-server` form will fail with a 404 until v0.2. Use a local stdio command from a source checkout instead.

```bash
git clone https://github.com/SergSlon/assignee-ai.git
cd assignee-ai
pnpm install && pnpm build
# The built server entry is at: apps/mcp-server/dist/index.js
```

## Setup

Add the assignee.ai MCP server to your IDE's MCP configuration, pointing at the local build.

### Cursor

Edit `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "assignee": {
      "command": "node",
      "args": ["/absolute/path/to/assignee-ai/apps/mcp-server/dist/index.js"],
      "env": {
        "ASSIGNEE_OPERATOR_ACCESS_KEY_ID": "<your-access-key>",
        "ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY": "<your-secret-key>",
        "AWS_REGION": "us-east-1"
      }
    }
  }
}
```

### Claude Code

Edit `~/.claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "assignee": {
      "command": "node",
      "args": ["/absolute/path/to/assignee-ai/apps/mcp-server/dist/index.js"],
      "env": {
        "ASSIGNEE_OPERATOR_ACCESS_KEY_ID": "<your-access-key>",
        "ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY": "<your-secret-key>",
        "AWS_REGION": "us-east-1"
      }
    }
  }
}
```

### Windsurf

Edit `~/.windsurf/mcp.json`:

```json
{
  "mcpServers": {
    "assignee": {
      "command": "node",
      "args": ["/absolute/path/to/assignee-ai/apps/mcp-server/dist/index.js"],
      "env": {
        "ASSIGNEE_OPERATOR_ACCESS_KEY_ID": "<your-access-key>",
        "ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY": "<your-secret-key>",
        "AWS_REGION": "us-east-1"
      }
    }
  }
}
```

After saving the configuration, restart your IDE. The server starts automatically when the first tool is called.

> **v0.2 note:** When `@assignee/mcp-server` is published to npm (target v0.2), the `"command": "node"` form above can be replaced with `"command": "npx", "args": ["-y", "assignee-mcp-server"]` for zero-install setup.

## Tools

### `plan_resource`

Generate an infrastructure plan from a natural language description. Returns a desired-state JSON, estimated monthly cost, and best practice findings.

**Parameters:**

| Name          | Type   | Required | Description                                                                                                 |
| ------------- | ------ | -------- | ----------------------------------------------------------------------------------------------------------- |
| `description` | string | yes      | Natural language description of the infrastructure (e.g., "Create an S3 bucket for static website hosting") |
| `region`      | string | no       | AWS region (e.g., "us-east-1"). Defaults to configured region.                                              |
| `env`         | string | no       | Environment tag (e.g., "dev", "staging", "prod"). Applied as a tag to the resource.                         |

**Example response:**

```json
{
  "resourceType": "AWS::S3::Bucket",
  "desiredState": {
    "BucketName": "my-static-site",
    "WebsiteConfiguration": {
      "IndexDocument": "index.html"
    },
    "PublicAccessBlockConfiguration": {
      "BlockPublicAcls": true,
      "BlockPublicPolicy": true,
      "IgnorePublicAcls": true,
      "RestrictPublicBuckets": true
    }
  },
  "estimatedMonthlyCost": "$0.0230/GB-month (live)",
  "bpFindings": [],
  "checkpointPath": "/tmp/assignee-mcp/checkpoint-abc123.json",
  "runId": "abc123"
}
```

### `apply_plan`

Apply a previously generated infrastructure plan. Provisions the resource via CloudControl API.

**Safety mechanism:** Requires `confirmed: true` to proceed. The AI agent must present the plan to the user and get explicit approval first. Setting `confirmed: false` acts as a dry-run validation.

**Parameters:**

| Name             | Type    | Required | Description                                                            |
| ---------------- | ------- | -------- | ---------------------------------------------------------------------- |
| `checkpointPath` | string  | yes      | Path to the plan checkpoint file (returned by `plan_resource`)         |
| `confirmed`      | boolean | yes      | Safety gate -- must be `true` to provision. `false` for dry-run check. |

**Example response (success):**

```json
{
  "status": "SUCCESS",
  "resourceArn": "arn:aws:s3:::my-static-site",
  "resourceType": "AWS::S3::Bucket",
  "estimatedMonthlyCost": "$X.XX/unit (live)",
  "securityFindings": [],
  "completedResources": [],
  "runId": "abc123"
}
```

### `list_managed_resources`

List all AWS resources currently managed by assignee.ai. Queries the Resource Groups Tagging API for resources tagged with `managed-by=assignee-ai`.

**Parameters:**

| Name           | Type   | Required | Description                                                                            |
| -------------- | ------ | -------- | -------------------------------------------------------------------------------------- |
| `region`       | string | no       | AWS region to query. Defaults to configured region.                                    |
| `resourceType` | string | no       | Filter by CloudFormation type (e.g., "AWS::S3::Bucket"). Returns all types if omitted. |

**Example response:**

```json
{
  "count": 2,
  "resources": [
    {
      "arn": "arn:aws:s3:::my-static-site",
      "resourceType": "AWS::S3::Bucket",
      "tags": { "managed-by": "assignee-ai", "env": "dev" }
    },
    {
      "arn": "arn:aws:lambda:us-east-1:123456789:function:my-handler",
      "resourceType": "AWS::Lambda::Function",
      "tags": { "managed-by": "assignee-ai", "env": "prod" }
    }
  ]
}
```

### `estimate_cost`

Estimate the monthly cost of an AWS resource without creating a full plan. Fast pricing lookup only -- no provisioning or state changes.

**Parameters:**

| Name           | Type   | Required | Description                                                                                    |
| -------------- | ------ | -------- | ---------------------------------------------------------------------------------------------- |
| `description`  | string | yes      | Natural language description (e.g., "RDS PostgreSQL db.t3.micro in us-east-1")                 |
| `resourceType` | string | no       | CloudFormation type (e.g., "AWS::RDS::DBInstance"). Overrides classification from description. |
| `desiredState` | object | no       | Desired-state JSON for the resource. Omit for a baseline estimate.                             |
| `region`       | string | no       | AWS region for pricing lookup. Defaults to "us-east-1".                                        |

**Example response:**

```json
{
  "resourceType": "AWS::RDS::DBInstance",
  "estimatedMonthlyCost": "$X.XX/month (live from Pricing MCP)",
  "description": "RDS PostgreSQL db.t3.micro in us-east-1",
  "region": "us-east-1",
  "note": "This is a baseline estimate. Use plan_resource for more accurate cost quotes that consider full resource configuration."
}
```

### `destroy_resource`

Destroy a managed AWS resource by ARN or name. Only resources tagged with `managed-by=assignee-ai` can be destroyed.

**Safety mechanism:** Same pattern as `apply_plan`. Requires `confirmed: true` to proceed. Setting `confirmed: false` resolves the resource and returns its details without deleting it.

**Parameters:**

| Name                  | Type    | Required | Description                                                               |
| --------------------- | ------- | -------- | ------------------------------------------------------------------------- |
| `resource_identifier` | string  | yes      | ARN or name of the resource to destroy                                    |
| `confirmed`           | boolean | yes      | Safety gate -- must be `true` to destroy. `false` for dry-run resolution. |

**Example response (dry-run with `confirmed: false`):**

```json
{
  "status": "PENDING_CONFIRMATION",
  "message": "Resource resolved. Set confirmed: true to proceed with destruction.",
  "resource": {
    "arn": "arn:aws:s3:::my-static-site",
    "resourceType": "AWS::S3::Bucket",
    "region": "us-east-1",
    "identifier": "my-static-site"
  }
}
```

**Example response (confirmed destroy):**

```json
{
  "status": "SUCCESS",
  "message": "Resource arn:aws:s3:::my-static-site destroyed successfully.",
  "resource": {
    "arn": "arn:aws:s3:::my-static-site",
    "resourceType": "AWS::S3::Bucket",
    "region": "us-east-1",
    "identifier": "my-static-site"
  }
}
```

## Example Workflow

A typical conversation with an AI agent using the MCP server:

1. **"Create an S3 bucket for my app logs"** -- agent calls `plan_resource`
2. Agent presents the plan, cost estimate, and best practice findings
3. **"Looks good, apply it"** -- agent calls `apply_plan` with `confirmed: true`
4. **"What resources do I have?"** -- agent calls `list_managed_resources`
5. **"How much would an RDS instance cost?"** -- agent calls `estimate_cost`
6. **"Delete the logs bucket"** -- agent calls `destroy_resource` with `confirmed: false` first, then `confirmed: true` after showing details

## Troubleshooting

### Server won't start

The MCP server requires Node.js >= 20. Check your version:

```bash
node --version
```

Ensure the repo is built (`pnpm build`) and the path in your MCP config points to the actual `apps/mcp-server/dist/index.js` file. Run the server manually to see startup errors:

```bash
node /absolute/path/to/assignee-ai/apps/mcp-server/dist/index.js
```

### "No credentials" or "Access Denied" errors

The server uses the same credential chain as the CLI. Verify credentials are set:

```bash
# Check that the env vars are configured in your MCP config
echo $ASSIGNEE_OPERATOR_ACCESS_KEY_ID
```

The MCP config `env` block must include either `ASSIGNEE_OPERATOR_ACCESS_KEY_ID` / `ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY` or standard AWS credential environment variables. SSO sessions are not supported in the MCP context because the server runs as a background process.

### "Graph context not initialized" error

This means the LangGraph pipeline failed to start. Common causes:

- Missing Amazon Bedrock access in the configured `AWS_REGION`
- Insufficient IAM permissions for `bedrock:InvokeModel`
- Stale MCP client state -- the `optionalInitPromise` is reset on close to prevent dangling references after reconnect

Check the server logs in your IDE's MCP output panel.

### "Unsupported resource type" from `plan_resource`

Not all CloudFormation types are supported yet. The 38 user-addressable types include S3, SSM Parameter, IAM Role, EC2, RDS, Lambda, VPC, Subnet, Security Group, DynamoDB, SQS, SNS, SNS Subscription, ELBv2 (ALB/NLB), ECS Cluster, ECR Repository, CloudWatch Logs, Internet Gateway, Route Table, Route, NAT Gateway, API Gateway V2, CloudWatch Alarm, Secrets Manager, EFS FileSystem, EFS MountTarget, EventBridge Rule, EventBridge EventBus, EventBridge Connection, EventBridge ApiDestination, KMS Key, CloudFront Distribution, CloudFront OAC, S3 BucketPolicy, Elastic IP (EIP), plus 2 compound-only types (`AWS::EC2::VPCGatewayAttachment`, `AWS::EC2::SubnetRouteTableAssociation`) that fall through to the generic plugin. See [resource-types.md](./resource-types.md) for the full list.

### `destroy_resource` failures

After the A6 and A10 migrations, every first-class supported type flows through the CloudControl API for destroy — there are no direct SDK write paths. Common failure causes:

- **Resource not found / tag not propagated**: Tags take ~60s to propagate after creation. If the resource was just provisioned, wait and retry.
- **CCAPI NotFound short-circuit**: If CloudControl returns NotFound, the destroy pipeline treats it as success (the resource is already gone). This is by design — see `packages/core/src/destroy-strategies/`.
- **Insufficient IAM permissions**: The operator IAM user must have `cloudcontrol:DeleteResource` for the resource type. Run `assignee doctor` to verify the IAM posture.
