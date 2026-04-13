# MCP Servers Reference

Assignee.ai uses 5 AWS MCP servers (+ 1 optional remote knowledge server) to enrich the pipeline with live AWS data. All servers are from the [AWS Labs MCP project](https://awslabs.github.io/mcp/).

## Server Inventory

| Server        | Package                                        | Pin      | Credential | Commands              | Purpose                        |
| ------------- | ---------------------------------------------- | -------- | ---------- | --------------------- | ------------------------------ |
| Pricing       | `awslabs.aws-pricing-mcp-server`               | `1.0.27` | reader     | plan, apply, optimize | Live $/hr for cost estimation  |
| Documentation | `awslabs.aws-documentation-mcp-server`         | `1.1.20` | reader     | plan, apply           | Field docs, runtime catalogs   |
| IAM           | `awslabs.iam-mcp-server`                       | `1.0.17` | auditor    | status                | IAM permission simulation      |
| WA Security   | `awslabs.well-architected-security-mcp-server` | `0.1.7`  | auditor    | status                | SecurityHub/GuardDuty findings |
| Billing       | `awslabs.billing-cost-management-mcp-server`   | `0.0.17` | reader     | status                | Live billing, cost forecast    |
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

### WA Security (`awslabs.well-architected-security-mcp-server@0.1.7`)

Upgraded in Story 45.1 from 1.0.2 (single `AnalyzeSecurityPosture` tool) to the multi-tool v0.1.7 API.

| Tool                     | Used By                                                                                                   | Purpose                                       |
| ------------------------ | --------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| `CheckSecurityServices`  | mcp-advisor, bp-mcp-enricher                                                                              | Verify security services enabled              |
| `GetSecurityFindings`    | security-posture.ts                                                                                       | Post-provision SecurityHub/GuardDuty findings |
| `CheckStorageEncryption` | Wired — used by bp-mcp-enricher.ts for storage encryption and network security BP evaluation (Story 45.4) | Data-at-rest protection checks                |
| `CheckNetworkSecurity`   | Wired — used by bp-mcp-enricher.ts for storage encryption and network security BP evaluation (Story 45.4) | Data-in-transit protection checks             |

### Billing (`awslabs.billing-cost-management-mcp-server@0.0.17`)

Upgraded in Story 45.2 from `awslabs.cost-management-mcp-server@1.0.2` (separate `get_cost_and_usage`/`get_cost_forecast` tools) to the unified `billing-cost-management-mcp-server@0.0.17` API with a single `cost-explorer` tool.

| Tool            | Used By                       | Purpose                                              |
| --------------- | ----------------------------- | ---------------------------------------------------- |
| `cost-explorer` | billing.ts, list-resources.ts | Live billing (getCostAndUsage by SERVICE) + forecast |

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

## MCP Version Drift Monitoring (Story 45.6)

`assignee doctor` includes an **MCP version drift** section that checks each pinned MCP server against the latest stable version on PyPI. For each of the 5 servers, the doctor reports one of three statuses:

| Status         | Meaning                                                  |
| -------------- | -------------------------------------------------------- |
| `up-to-date`   | Pinned version matches (or exceeds) PyPI latest          |
| `behind`       | Pinned version is older than PyPI latest — review needed |
| `fetch-failed` | PyPI unreachable or timed out (5s per fetch)             |

The check runs in parallel across all servers via `Promise.all` with per-server `AbortController` timeouts, so a single slow PyPI response never blocks the other rows. Network failures are isolated — they produce `fetch-failed` rows, not exceptions.

A standalone CI script (`apps/cli/scripts/check-mcp-versions.ts`) wraps the same logic for automated pipelines:

- Any `behind` row exits with code 1 (fail CI — humans must bump deliberately)
- All `fetch-failed` rows exit 0 with a stderr warning (don't break CI on offline runners)
- Otherwise exit 0

The drift check can be skipped via `assignee doctor --skip-version-check` for offline or fast-path usage.

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
