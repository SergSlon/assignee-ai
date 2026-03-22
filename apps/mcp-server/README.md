# @assignee/mcp-server

AI-native AWS infrastructure provisioning via MCP (Model Context Protocol). Plan, estimate, and deploy AWS resources using natural language from any AI coding agent.

## Prerequisites

- **Node.js** >= 20.0.0
- **AWS credentials** configured (environment variables or `~/.aws/credentials`)
- **Python 3.10+** and **uvx** (for MCP sub-servers: CloudFormation, pricing, knowledge base, AWS docs)

## Quick Start

### Claude Code

```bash
claude mcp add assignee-ai -- npx @assignee/mcp-server
```

Or add to `.claude/mcp_config.json`:

```json
{
  "mcpServers": {
    "assignee-ai": {
      "command": "npx",
      "args": ["@assignee/mcp-server"],
      "env": {
        "AWS_REGION": "us-east-1",
        "MCP_AWS_ACCESS_KEY_ID": "your-key",
        "MCP_AWS_SECRET_ACCESS_KEY": "your-secret"
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
      "command": "npx",
      "args": ["@assignee/mcp-server"],
      "env": {
        "AWS_REGION": "us-east-1",
        "MCP_AWS_ACCESS_KEY_ID": "your-key",
        "MCP_AWS_SECRET_ACCESS_KEY": "your-secret"
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
      "command": "npx",
      "args": ["@assignee/mcp-server"],
      "env": {
        "AWS_REGION": "us-east-1",
        "MCP_AWS_ACCESS_KEY_ID": "your-key",
        "MCP_AWS_SECRET_ACCESS_KEY": "your-secret"
      }
    }
  }
}
```

### Global Install (Alternative)

For faster startup, install globally instead of using `npx`:

```bash
npm install -g @assignee/mcp-server
```

Then use `assignee-mcp-server` as the command in your agent config instead of `npx @assignee/mcp-server`.

## Available Tools

| Tool                     | Description                           | Input                                                    |
| :----------------------- | :------------------------------------ | :------------------------------------------------------- |
| `plan_resource`          | Generate an infrastructure plan       | `{ description: string, region?: string, env?: string }` |
| `apply_plan`             | Apply a previously generated plan     | `{ checkpointPath: string, confirmed: boolean }`         |
| `list_managed_resources` | List resources managed by assignee.ai | `{ region?: string }`                                    |
| `estimate_cost`          | Estimate monthly cost of a resource   | `{ description: string, region?: string }`               |

## Environment Variables

| Variable                    | Required | Description                                |
| :-------------------------- | :------- | :----------------------------------------- |
| `AWS_REGION`                | Yes      | Default AWS region for provisioning        |
| `MCP_AWS_ACCESS_KEY_ID`     | Yes      | AWS access key for MCP sub-servers         |
| `MCP_AWS_SECRET_ACCESS_KEY` | Yes      | AWS secret key for MCP sub-servers         |
| `ASSIGNEE_MODEL`            | No       | LLM model string (default: Bedrock Claude) |

> **Security Note:** Never commit AWS credentials to version control. Use environment variables or AWS credential profiles. For shared team setups, consider using `aws-vault` or similar credential management tools.

## Troubleshooting

### Server fails to start

1. Verify Node.js version: `node --version` (must be >= 20.0.0)
2. Check AWS credentials are configured: `aws sts get-caller-identity`
3. Ensure Python and uvx are installed: `uvx --version`

### Tools return NOT_READY

The MCP sub-servers (CloudFormation, pricing, knowledge base) may not have initialized. Check stderr output for initialization warnings. Ensure Python dependencies are available.

### npx is slow on first run

The first `npx @assignee/mcp-server` invocation downloads the package (30-60s). Subsequent runs use the npx cache. For instant startup, use a global install instead.

### Connection issues with AI agent

- Verify the MCP config JSON is valid (no trailing commas)
- Restart your AI agent after modifying MCP configuration
- Check agent logs for MCP connection errors

## Links

- [assignee.ai](https://assignee.ai) -- Project homepage
- [GitHub](https://github.com/assignee-ai/assignee) -- Source code
- [CLI package](https://www.npmjs.com/package/assignee) -- `@assignee/cli` on npm
