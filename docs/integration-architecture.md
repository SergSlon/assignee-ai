# Assignee.ai -- Integration Architecture

> Reverse-engineered from source code, April 2026.

## Overview

Assignee.ai has three primary packages that integrate with each other:

```
                    +-------------------+
                    |   @assignee/core  |
                    | (types, plugins,  |
                    |  pricing, config) |
                    +-------------------+
                       /             \
                      /               \
          +-----------+           +------------------+
          |  apps/cli |           | apps/mcp-server  |
          | (12 cmds, |           | (5 MCP tools,    |
          |  12 nodes)|           |  stdio transport) |
          +-----------+           +------------------+
               |                         |
               |  depends on             |  depends on
               v                         v
    +--------------------+    +--------------------+
    | @assignee/best-    |    |  assignee (CLI)    |
    | practices          |    |  (workspace dep)   |
    +--------------------+    +--------------------+
```

## What Lives Where

### @assignee/core (`packages/core/`)

The shared foundation. Contains **zero business logic** -- only types, data, and pure functions.

**Provides to both CLI and MCP server:**

- All 23 resource type constants and type definitions
- Resource plugin registry (24 plugins with wizard field definitions)
- Pattern template registry (7 compound architecture patterns)
- Pricing strategy registry (23 strategies) and decomposer registry (23 decomposers)
- CloudFormation schema service (DescribeType + disk cache)
- Schema adapter (raw CloudFormation -> normalized format)
- Schema cache warmer (pre-fetch all schemas)
- IAM policy generators (operator, reader, auditor)
- IAM action mapping per resource type
- ARN-to-CloudFormation type mapping
- Config schema (AssigneeConfig Zod validation)
- Error class hierarchy (AssigneeError, McpError, etc.)
- LlmPort interface + MockLlmAdapter
- Graph state enums (ExecutionMode, ExecutionStatus, etc.)
- Zod schemas for checkpoints, memory, audit, drift
- Result<T> tuple type
- Intent sanitization (prompt injection protection)

### CLI (`apps/cli/`)

The primary user-facing application. Contains all business logic.

**Unique to CLI:**

- 12-node LangGraph pipeline (graph.ts + all nodes)
- Interactive wizard (option-elicitor with clack prompts)
- 12 Commander.js commands
- MCP server process management (spawn/lifecycle)
- AWS SDK integration (CloudControl, EC2, IAM, STS, S3, Lambda, SNS, CloudFront)
- 6-level configuration precedence system
- Memory system (provision/failure/pattern logs)
- Checkpoint system (plan save/load/resume)
- Drift detection and reconciliation
- Cleanup orchestrator
- Billing integration
- Recording interceptor
- Display/UI rendering (plan boxes, tables, progress bars)
- Shell completion generation
- First-run bootstrap
- Telemetry/timing

### MCP Server (`apps/mcp-server/`)

Exposes CLI capabilities to AI coding assistants via Model Context Protocol.

**Unique to MCP server:**

- 5 MCP tool registrations (plan, apply, list, estimate, destroy)
- McpServer + StdioServerTransport setup
- Graph context initialization (shared graph, different lifecycle)
- MCP-specific checkpoint management
- Cost estimator service (keyword-based resource classification)
- Destroy strategy registry (type-specific destroy handlers)
- Free tier awareness service

## How CLI and MCP Server Integrate

### Shared Graph

Both CLI and MCP server use the **same LangGraph pipeline** from `apps/cli/src/services/graph.ts`. The MCP server imports `createGraph()` from the CLI package (via `assignee` workspace dependency).

**CLI invocation path:**

```
Commander command -> runCommand(intent) -> createGraph() -> graph.invoke(initialState)
```

**MCP invocation path:**

```
MCP tool handler -> createGraphContext() -> graph.invoke(initialState)
```

### Key Differences

| Aspect               | CLI                                      | MCP Server                               |
| -------------------- | ---------------------------------------- | ---------------------------------------- |
| **User interaction** | Interactive TTY (clack prompts)          | Structured JSON responses                |
| **Wizard**           | Interactive option_elicitor              | `--no-wizard` mode (skips prompts)       |
| **HITL**             | Interactive confirmation prompt          | `confirmed: true` parameter              |
| **Auto-approve**     | `--yes` flag                             | Always auto-approve                      |
| **Output**           | Formatted terminal (boxen, chalk)        | Structured JSON via MCP protocol         |
| **MCP clients**      | Spawns external MCP servers              | Does NOT spawn MCP servers (is one)      |
| **Config**           | 6-level precedence from files            | Env vars only                            |
| **Checkpoints**      | `.assignee/` project directory           | Separate MCP checkpoint directory        |
| **Process model**    | Short-lived (one command)                | Long-lived (persistent stdio)            |
| **Cost estimation**  | Full pipeline (MCP pricing + decomposer) | Lightweight keyword-based classification |
| **Destroy**          | CloudControl + SDK fallback              | Strategy registry pattern                |
| **Drift**            | Full drift detection + reconciliation    | Not exposed as MCP tool                  |

### What MCP Server Reuses from CLI

The MCP server has a `"assignee": "workspace:*"` dependency, giving it access to:

- `createGraph()` function and all 12 nodes
- `CloudControlAdapter` and `SDKFallbackDispatcher`
- `MemoryService` for provision/failure recording
- `fetchManagedResources()` for resource listing
- All display utilities (though it formats differently)
- Checkpoint serialization functions

### What MCP Server Does NOT Reuse

- Interactive prompts (no TTY in MCP)
- Config loaders (project/user/org)
- Drift detection and reconciliation
- Setup command (IAM bootstrap)
- Shell completions
- First-run experience
- Billing integration

## External Service Integration

### MCP Servers Consumed by CLI

The CLI spawns MCP server child processes for external data:

| Server                                 | Package | Credential | Purpose                        |
| -------------------------------------- | ------- | ---------- | ------------------------------ |
| `aws-pricing-mcp-server`               | uvx     | Reader     | Real-time AWS pricing data     |
| `aws-documentation-mcp-server`         | uvx     | Reader     | AWS documentation references   |
| `aws-iam-mcp-server`                   | uvx     | Auditor    | IAM permission simulation      |
| `aws-cost-management-mcp-server`       | uvx     | Reader     | Live billing data              |
| `well-architected-security-mcp-server` | uvx     | Auditor    | Post-provision security checks |

**Lazy loading:** Not all servers start on every command. Each command declares which servers it needs (Story 29.3).

**Graceful degradation:** All MCP server failures are non-blocking. The pipeline falls back to local estimates, skips security checks, etc.

### LLM Providers

Via Vercel AI SDK (`ai` package), the CLI integrates with:

- Amazon Bedrock (`@ai-sdk/amazon-bedrock`)
- Anthropic (`@ai-sdk/anthropic`)
- OpenAI (`@ai-sdk/openai`)
- Google (`@ai-sdk/google`)
- Ollama (via OpenAI-compatible endpoint)

LLM is used in exactly 2 nodes: intent_parser (structured classification) and plan_generator (JSON generation).

### AWS SDK Services

Direct SDK calls (not via MCP):

- CloudControl API -- resource CRUD + polling
- CloudFormation Registry -- schema DescribeType
- EC2 -- AMI/VPC/subnet/SG/instance type discovery, EIP allocation, key pair management
- Resource Groups Tagging API -- resource listing
- IAM -- setup command (user/policy/role creation)
- STS -- account identity for ARN construction
- S3 -- static site upload
- Lambda -- EventSourceMapping creation (CCAPI fallback)
- SNS -- Subscription creation (CCAPI fallback)
- CloudFront -- distribution creation (post-provision)
