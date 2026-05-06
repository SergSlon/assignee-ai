# @assignee/mcp-server

AI-native AWS infrastructure provisioning via MCP (Model Context Protocol). Plan, estimate, and deploy AWS resources using natural language from any AI coding agent.

This package is part of the Assignee.ai course-project submission for the Generative AI for Developers micro-master's program. The package is `private: true` — it is not published to npm and is consumed by running the locally-built `dist/index.js` from a clone of this repository.

## Prerequisites

- **Node.js** >= 20.11
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
        "AWS_PROFILE": "your-aws-profile",
        "AWS_REGION": "us-east-1"
      }
    }
  }
}
```

> **Static-key fallback:** If a named profile is not available, set `ASSIGNEE_OPERATOR_ACCESS_KEY_ID` and `ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY` in the `env` block. Using `AWS_PROFILE` is preferred — it keeps credentials out of the config file and out of process tables.

### Cursor

Add to `.cursor/mcp.json` in your project root:

```json
{
  "mcpServers": {
    "assignee-ai": {
      "command": "node",
      "args": ["/absolute/path/to/assignee.ai/apps/mcp-server/dist/index.js"],
      "env": {
        "AWS_PROFILE": "your-aws-profile",
        "AWS_REGION": "us-east-1"
      }
    }
  }
}
```

> **Static-key fallback:** Set `ASSIGNEE_OPERATOR_ACCESS_KEY_ID` / `ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY` only when a named profile is not available.

### Windsurf

Add to your Windsurf MCP configuration:

```json
{
  "mcpServers": {
    "assignee-ai": {
      "command": "node",
      "args": ["/absolute/path/to/assignee.ai/apps/mcp-server/dist/index.js"],
      "env": {
        "AWS_PROFILE": "your-aws-profile",
        "AWS_REGION": "us-east-1"
      }
    }
  }
}
```

> **Static-key fallback:** Set `ASSIGNEE_OPERATOR_ACCESS_KEY_ID` / `ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY` only when a named profile is not available.

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

| Variable                              | Required    | Description                                                                                     |
| :------------------------------------ | :---------- | :---------------------------------------------------------------------------------------------- |
| `AWS_REGION`                          | Yes         | Default AWS region for provisioning                                                             |
| `AWS_PROFILE`                         | Recommended | Named AWS credentials profile. Preferred over raw key vars — keeps secrets out of config files. |
| `AWS_SHARED_CREDENTIALS_FILE`         | No          | Path to credentials file if not at the default `~/.aws/credentials` location.                   |
| `ASSIGNEE_OPERATOR_ACCESS_KEY_ID`     | No          | AWS access key (static-key fallback only — prefer `AWS_PROFILE`)                                |
| `ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY` | No          | AWS secret key (static-key fallback only — prefer `AWS_PROFILE`)                                |
| `ASSIGNEE_LLM_DEFAULT`                | No          | LLM model string (default: `bedrock/amazon.nova-lite-v1:0`)                                     |

> **Security Note:** Prefer `AWS_PROFILE` over embedding raw access keys in the MCP config. Raw keys in the `env` block are visible in the host process environment and in `ps eww` output for any local user with the same UID. Never commit AWS credentials to version control. For shared team setups, consider using `aws-vault` or similar credential management tools.

## Troubleshooting

### Server fails to start

1. Verify Node.js version: `node --version` (must be >= 20.11)
2. Check AWS credentials are configured: `aws sts get-caller-identity`
3. Ensure Python 3.10+ is installed: `python3 --version`
4. Ensure uvx is installed: `uvx --version`

### Tools return NOT_READY

The MCP sub-servers (Pricing, Documentation, IAM, Well-Architected Security, Cost Management) may not have initialized. Check stderr output for initialization warnings. Ensure Python 3.10+ and uvx are available on your PATH. CloudFormation schemas are fetched directly via `@aws-sdk/client-cloudformation`, not via an MCP sub-server.

### Connection issues with AI agent

- Verify the MCP config JSON is valid (no trailing commas)
- Restart your AI agent after modifying MCP configuration
- Check agent logs for MCP connection errors

## Distribution

This package stays `private: true` for the course-project submission. The no-public-artifacts policy is documented in the contributor guide — see [`CONTRIBUTING.md`](../../CONTRIBUTING.md).
