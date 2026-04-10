# @assignee/mcp-server

AI-native AWS infrastructure provisioning via MCP (Model Context Protocol). Plan, estimate, and deploy AWS resources using natural language from any AI coding agent.

> **Status:** Not yet published to npm. The instructions below use local paths from a cloned repo; an npm-based install will replace them once the package is published.

## Prerequisites

- **Node.js** >= 20.0.0
- **Python 3.10+** (required by MCP sub-servers)
- **uvx** (Python package runner, used to launch pricing, documentation, IAM, security, and cost management sub-servers)
- **AWS credentials** configured (environment variables or `~/.aws/credentials`)

## Quick Start (Local Development)

First, build the MCP server from the repo root:

```bash
pnpm install
pnpm --filter @assignee/mcp-server build
```

### Claude Code

```bash
claude mcp add assignee-ai -- node /absolute/path/to/assignee.ai/apps/mcp-server/dist/index.js
```

Or add to `.claude/mcp_config.json`:

```json
{
  "mcpServers": {
    "assignee-ai": {
      "command": "node",
      "args": ["/absolute/path/to/assignee.ai/apps/mcp-server/dist/index.js"],
      "env": {
        "AWS_REGION": "us-east-1",
        "ASSIGNEE_OPERATOR_ACCESS_KEY_ID": "your-key",
        "ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY": "your-secret"
      }
    }
  }
}
```

### Cursor

Add to `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "assignee-ai": {
      "command": "node",
      "args": ["/absolute/path/to/assignee.ai/apps/mcp-server/dist/index.js"],
      "env": {
        "AWS_REGION": "us-east-1",
        "ASSIGNEE_OPERATOR_ACCESS_KEY_ID": "your-key",
        "ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY": "your-secret"
      }
    }
  }
}
```

### Windsurf

Add to your Windsurf MCP configuration:

```json
{
  "mcpServers": {
    "assignee-ai": {
      "command": "node",
      "args": ["/absolute/path/to/assignee.ai/apps/mcp-server/dist/index.js"],
      "env": {
        "AWS_REGION": "us-east-1",
        "ASSIGNEE_OPERATOR_ACCESS_KEY_ID": "your-key",
        "ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY": "your-secret"
      }
    }
  }
}
```

> Replace `/absolute/path/to/assignee.ai` with the actual path to your local clone of the repository.

## Available Tools

| Tool                     | Description                                     | Input                                                         |
| :----------------------- | :---------------------------------------------- | :------------------------------------------------------------ |
| `plan_resource`          | Generate an infrastructure plan                 | `{ description: string, region?: string, env?: string }`      |
| `apply_plan`             | Apply a previously generated plan               | `{ checkpointPath: string, confirmed: boolean }`              |
| `list_managed_resources` | List resources managed by assignee.ai           | `{ region?: string }`                                         |
| `estimate_cost`          | Estimate monthly cost of a resource             | `{ description: string, region?: string }`                    |
| `destroy_resource`       | Safely tear down a managed resource by ARN/name | `{ identifier: string, region?: string, confirmed: boolean }` |

> **Note:** `destroy_resource` requires `confirmed: true` to proceed — the calling agent must present resource details to the user and obtain explicit approval first. Resources are resolved via the Resource Groups Tagging API, deleted via CloudControl, and polled until completion. See [docs/mcp-server.md](../../docs/mcp-server.md) for the full reference.

## Environment Variables

| Variable                              | Required | Description                                                        |
| :------------------------------------ | :------- | :----------------------------------------------------------------- |
| `AWS_REGION`                          | Yes      | Default AWS region for provisioning                                |
| `ASSIGNEE_OPERATOR_ACCESS_KEY_ID`     | Yes      | AWS access key for the operator                                    |
| `ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY` | Yes      | AWS secret key for the operator                                    |
| `ASSIGNEE_MODEL`                      | No       | LLM model string (default: `us.amazon.nova-lite-v1:0` via Bedrock) |

> **Security Note:** Never commit AWS credentials to version control. Use environment variables or AWS credential profiles. For shared team setups, consider using `aws-vault` or similar credential management tools.

## Troubleshooting

### Server fails to start

1. Verify Node.js version: `node --version` (must be >= 20.0.0)
2. Check AWS credentials are configured: `aws sts get-caller-identity`
3. Ensure Python 3.10+ is installed: `python3 --version`
4. Ensure uvx is installed: `uvx --version`

### Tools return NOT_READY

The MCP sub-servers (CloudFormation, pricing, knowledge base) may not have initialized. Check stderr output for initialization warnings. Ensure Python 3.10+ and uvx are available on your PATH.

### Connection issues with AI agent

- Verify the MCP config JSON is valid (no trailing commas)
- Restart your AI agent after modifying MCP configuration
- Check agent logs for MCP connection errors

## After publish (coming soon)

Once `@assignee/mcp-server` is published to npm, the local-path `args` shown above can be replaced with an `npx` invocation, no clone required:

```json
{
  "mcpServers": {
    "assignee-ai": {
      "command": "npx",
      "args": ["-y", "@assignee/mcp-server"],
      "env": {
        "AWS_REGION": "us-east-1",
        "ASSIGNEE_OPERATOR_ACCESS_KEY_ID": "your-key",
        "ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY": "your-secret"
      }
    }
  }
}
```

Equivalently, from a shell:

```bash
npx @assignee/mcp-server
```

The package stays `private` until the CLI is approved for release — see the project's [no-public-artifacts policy](../../CLAUDE.md).

## Links

- [assignee.ai](https://assignee.ai) -- Project homepage (coming soon)
- [GitHub](https://github.com/assignee-ai/assignee) -- Source code (coming soon)
- [npm package](https://www.npmjs.com/package/@assignee/mcp-server) -- npm registry (coming soon, package is currently private)
