# MCP Servers Reference

Assignee.ai uses 5 AWS MCP servers (+ 1 optional remote knowledge server) to enrich the pipeline with live AWS data. All servers are from the [AWS Labs MCP project](https://awslabs.github.io/mcp/).

## Server Inventory

| Server        | Package                                        | Pin      | Credential | Commands              | Purpose                        |
| ------------- | ---------------------------------------------- | -------- | ---------- | --------------------- | ------------------------------ |
| Pricing       | `awslabs.aws-pricing-mcp-server`               | `1.0.27` | reader     | plan, apply, optimize | Live $/hr for cost estimation  |
| Documentation | `awslabs.aws-documentation-mcp-server`         | `1.1.20` | reader     | plan, apply           | Field docs, runtime catalogs   |
| IAM           | `awslabs.iam-mcp-server`                       | `1.0.17` | auditor    | status                | IAM permission simulation      |
| WA Security   | `awslabs.well-architected-security-mcp-server` | `1.0.2`  | auditor    | status                | SecurityHub/GuardDuty findings |
| Billing       | `awslabs.cost-management-mcp-server`           | `1.0.2`  | reader     | status                | Live billing, cost forecast    |
| Knowledge     | `knowledge-mcp.global.api.aws`                 | remote   | reader     | plan, apply           | Optional remote AWS knowledge  |

**Pin location:** `apps/cli/src/config/mcp-servers.ts` → `MCP_PINS`

**Lazy loading:** Each CLI command only starts the servers it needs (see `apps/cli/src/mcp/server-map.ts`). `list`, `destroy`, `clean`, `init`, `setup`, `drift` start zero servers.

## Tools by Server

### Pricing (`awslabs.aws-pricing-mcp-server@1.0.27`)

| Tool          | Used By                                                                          | Purpose                                                        |
| ------------- | -------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `get_pricing` | option-elicitor, preflight-guard, mcp-advisor, cost-optimizer, pricing-lookup.ts | Live $/hr in wizard prompts, cost estimation gate, rightsizing |

**AWS Pricing API service codes used:**

- `AmazonEC2` — EC2 instance pricing
- `AmazonRDS` — RDS instance class pricing
- `AWSLambda` — Lambda invocation + duration pricing
- `AmazonS3` — S3 storage pricing
- `AWSSystemsManager` — SSM Parameter Store pricing
- `AmazonCloudWatch` — CloudWatch Logs storage pricing
- `AmazonBedrock` — Bedrock model inference pricing (Nova, older Claude, DeepSeek, Llama)
- `AmazonBedrockService` — Bedrock cross-region inference pricing (Claude Sonnet 4, 4.5)

**Important:** Newer Claude models (Sonnet 4.6, Haiku 4.5) are not yet in the AWS Pricing API. Use the Anthropic API pricing page for those.

### Documentation (`awslabs.aws-documentation-mcp-server@1.1.20`)

| Tool                   | Used By                                       | Purpose                                    |
| ---------------------- | --------------------------------------------- | ------------------------------------------ |
| `search_documentation` | mcp-advisor, bp-mcp-enricher, display-docs.ts | Context hints, BP validation, field help   |
| `read_sections`        | display-docs.ts                               | Full doc page reads for trade-off analysis |
| `read_documentation`   | display-docs.ts                               | Direct doc page reads                      |

### IAM (`awslabs.iam-mcp-server@1.0.17`)

| Tool                        | Used By         | Purpose                             |
| --------------------------- | --------------- | ----------------------------------- |
| `simulate_principal_policy` | preflight-guard | Pre-apply IAM permission validation |

### WA Security (`awslabs.well-architected-security-mcp-server@1.0.2`)

**Upgrade blocked:** Newer versions (0.1.x) renamed `AnalyzeSecurityPosture` to `CheckSecurityServices` + split into multiple tools. Requires code changes in security-posture.ts, mcp-advisor.ts, bp-mcp-enricher.ts.

| Tool                     | Used By                                           | Purpose                                       |
| ------------------------ | ------------------------------------------------- | --------------------------------------------- |
| `AnalyzeSecurityPosture` | mcp-advisor, bp-mcp-enricher, security-posture.ts | Post-provision SecurityHub/GuardDuty findings |

### Billing (`awslabs.cost-management-mcp-server@1.0.2`)

**Upgrade blocked:** Newer package (`billing-cost-management-mcp-server`) replaced `get_cost_and_usage`/`get_cost_forecast` with a single `cost-explorer` tool using an `operation` parameter. Requires code changes in billing.ts and list-resources.ts.

| Tool                 | Used By                       | Purpose                               |
| -------------------- | ----------------------------- | ------------------------------------- |
| `get_cost_and_usage` | billing.ts, list-resources.ts | Live billing for current month        |
| `get_cost_forecast`  | billing.ts                    | Forecast for destroy savings estimate |

## Credential Model (3-user isolation)

| Role     | Env Vars                                                 | Used By                               | Permissions                                       |
| -------- | -------------------------------------------------------- | ------------------------------------- | ------------------------------------------------- |
| Operator | `ASSIGNEE_OPERATOR_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` | CLI directly (Bedrock + CloudControl) | bedrock:InvokeModel, cloudcontrol:\*              |
| Reader   | `ASSIGNEE_READER_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY`   | Pricing, Documentation, Billing MCPs  | pricing:GetProducts, ce:GetCost\*, docs read-only |
| Auditor  | `ASSIGNEE_AUDITOR_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY`  | IAM, WA Security MCPs                 | iam:Simulate*, securityhub:Get*, guardduty:Get\*  |

MCP subprocesses receive credentials via env var injection — never via shared AWS profile or IMDS. Empty credentials are never passed (throws `MissingAssigneeCredentialsError` before spawn).

## Security

- **Supply-chain pinning:** Every package pinned to exact version. Never `@latest`. Bump after reviewing release notes.
- **Subprocess isolation:** Each MCP server runs as a separate `uvx` subprocess with its own credential scope.
- **Graceful degradation:** Optional servers (IAM, WA Security, Billing) fail silently — core pipeline continues.
- **Timeouts:** 3s per MCP call in advice pipeline, 6s for pricing lookups, 5s for doctor probes.
- **Remote server gated:** Knowledge MCP (`knowledge-mcp.global.api.aws`) is OFF by default, requires explicit `ASSIGNEE_ENABLE_REMOTE_MCP=1`.

## Updating Pins

1. Check latest versions: `pip index versions awslabs.aws-pricing-mcp-server` (or visit PyPI)
2. Review upstream release notes at [github.com/awslabs/mcp/releases](https://github.com/awslabs/mcp/releases)
3. Update `MCP_PINS` in `apps/cli/src/config/mcp-servers.ts`
4. Run `pnpm build && pnpm test` — the pin tests in `mcp-servers.test.ts` verify format
5. Update this doc's version table

## Claude Code MCP Configuration

For local development, configure the Pricing MCP in `.mcp.json` at the repo root:

```json
{
  "mcpServers": {
    "aws-pricing": {
      "command": "uvx",
      "args": ["awslabs.aws-pricing-mcp-server@1.0.27"],
      "env": {
        "AWS_ACCESS_KEY_ID": "<READER_KEY>",
        "AWS_SECRET_ACCESS_KEY": "<READER_SECRET>",
        "AWS_REGION": "us-east-1"
      }
    }
  }
}
```

This gives Claude Code access to `get_pricing` for live cost queries during development sessions.
