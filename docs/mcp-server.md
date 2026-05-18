---
diataxis: how-to
canonical: true
---

> [!WARNING]
> **Multi-quadrant doc** — this page mixes Diátaxis quadrants: how-to (IDE
> setup), reference (per-tool parameter schemas), and troubleshooting.
> A future revision should shard it into separate how-to / reference /
> troubleshooting pages; for now the boundaries are signposted by H2
> headings (`Setup` is how-to, `Tools` is reference, `Troubleshooting`
> is troubleshooting).

# MCP Server

Expose assignee.ai as [Model Context Protocol](https://modelcontextprotocol.io/) tools so AI-powered IDEs can plan, estimate, provision, and destroy AWS infrastructure through natural conversation.

## What This Does

The MCP server wraps the same LangGraph pipeline that powers the CLI (see [`packages/core/src/graph/create-graph.ts`](../packages/core/src/graph/create-graph.ts)) and exposes it as MCP tools registered in [`apps/mcp-server/src/tools/`](../apps/mcp-server/src/tools/). Any MCP-compatible client (Cursor, Claude Code, Windsurf, etc.) can call these tools to manage AWS resources without leaving the editor.

## Prerequisites

- Node.js >= 20
- AWS credentials configured (same credential chain as the CLI -- see [Quickstart](./how-to/quickstart.md#prerequisites))
- Amazon Bedrock access in your region
- A source build of the repo (see Install section below)

## Install (source build required)

> **Course-project notice:** `@assignee/mcp-server` is `"private": true` and is not published to any registry. This is a final-project submission for the "Generative AI for Developers" micro-master's program; there is no published npm package or hosted runtime. Use a local `node` invocation against the built dist file from a source checkout.

```bash
git clone https://github.com/SergSlon/assignee-ai.git
cd assignee-ai
pnpm install && pnpm build
# The built server entry is at: apps/mcp-server/dist/index.js
# Invoke as: node apps/mcp-server/dist/index.js
```

## Setup

Every supported IDE consumes the same canonical MCP server entry — only the config-file location differs. Drop the JSON snippet below into the file for your IDE, restart the IDE, and the server will start automatically when the first tool is called.

### Canonical MCP server entry

```json
{
  "mcpServers": {
    "assignee": {
      "command": "node",
      "args": ["/absolute/path/to/assignee-ai/apps/mcp-server/dist/index.js"],
      "env": {
        "AWS_PROFILE": "your-aws-profile",
        "AWS_REGION": "us-east-1"
      }
    }
  }
}
```

### IDE → config-file path

| IDE             | Config file                                                                                                                                                                              |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Cursor          | `~/.cursor/mcp.json`                                                                                                                                                                     |
| Claude Code CLI | `.claude/mcp_config.json` (or run `claude mcp add assignee -- node /absolute/path/to/assignee-ai/apps/mcp-server/dist/index.js`)                                                         |
| Claude Desktop  | macOS: `~/Library/Application Support/Claude/claude_desktop_config.json` · Windows: `%APPDATA%\Claude\claude_desktop_config.json` · Linux: `~/.config/Claude/claude_desktop_config.json` |
| Windsurf        | `~/.windsurf/mcp.json`                                                                                                                                                                   |

> **Static-key fallback:** If you cannot use `AWS_PROFILE` (e.g.
> static-key-only environments), set `ASSIGNEE_OPERATOR_ACCESS_KEY_ID`
> and `ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY` in the `env` block instead.
> Embedding raw keys in the config file exposes them in the host
> process's environment and in `ps eww` output for any local user with
> the same UID — prefer profile-based auth whenever possible.

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
      "arn": "arn:aws:lambda:us-east-1:123456789012:function:my-handler",
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

**Reconnect loops:** If the MCP host (Cursor/Claude Desktop/Windsurf) restarts, the assignee process will exit and be respawned by the host — this is the expected MCP stdio lifecycle. If you see repeated reconnect attempts, check `~/.assignee/logs/cli-…jsonl` for the actual error that is causing the respawn cycle.

### "No credentials" or "Access Denied" errors

The server uses the same credential chain as the CLI. The recommended approach is to use a named AWS profile:

```bash
# Verify the profile resolves credentials correctly
AWS_PROFILE=your-aws-profile aws sts get-caller-identity
```

Set `AWS_PROFILE` (and optionally `AWS_SHARED_CREDENTIALS_FILE` if your credentials file is in a non-default location) in the MCP config `env` block.

**Static-key fallback:** If a named profile is not available, you can set `ASSIGNEE_OPERATOR_ACCESS_KEY_ID` and `ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY` directly in the `env` block. Be aware that raw keys placed in the MCP config file are visible in the host process's environment and in `ps eww` output for any local user with the same UID. Prefer profile-based auth whenever possible.

Because the MCP server runs as a long-lived background process, SSO token refresh is not automatic — if you use short-lived credentials, set `ASSIGNEE_OPERATOR_SESSION_TOKEN` alongside the key pair, or rotate the credentials in the MCP config before the session expires.

**Lazy credential resolution:** Each credentialed MCP sub-server (Pricing, IAM, WA Security, Billing) resolves credentials independently with its own try/catch. The Documentation server takes no AWS credentials. A missing or invalid credential set for one server does not crash the others — the affected server reports a startup failure and the remaining servers continue normally.

### "Graph context not initialized" error

This means the LangGraph pipeline failed to start. Common causes:

- Missing Amazon Bedrock access in the configured `AWS_REGION`
- Insufficient IAM permissions for `bedrock:InvokeModel`
- Stale MCP client state -- the `optionalInitPromise` is reset on close to prevent dangling references after reconnect

Check the server logs in your IDE's MCP output panel.

### "Unsupported resource type" from `plan_resource`

Not all CloudFormation types are supported yet. See [resource-types.md](./resource-types.md) for the authoritative and up-to-date list of supported types — the registry is the single source of truth and is always in sync with the running code.

### Audit log append failures

The MCP server maintains an append-only audit log of all tool invocations.
If a write fails (disk full, permissions error), the server emits a
structured warning via `mcpLogError`:

```json
{ "action": "append-failed", "source": "audit-log", "reason": "<OS error>" }
```

The server continues operating after an append failure, but the affected
operation will not appear in `assignee admin audit-verify` output. Check disk
space and permissions under `~/.assignee/logs/`.

### `destroy_resource` failures

Every first-class supported type flows through the CloudControl API for destroy — there are no direct SDK write paths. Common failure causes:

- **Resource not found / tag not propagated**: Tags take ~60s to propagate after creation. If the resource was just provisioned, wait and retry.
- **CCAPI NotFound short-circuit**: If CloudControl returns NotFound, the destroy pipeline treats it as success (the resource is already gone). This is by design — see `packages/core/src/destroy-strategies/`.
- **Insufficient IAM permissions**: The operator IAM user must have `cloudcontrol:DeleteResource` for the resource type. Run `assignee admin doctor` to verify the IAM posture.
