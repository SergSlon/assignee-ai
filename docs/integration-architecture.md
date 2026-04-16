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
          | (17 cmds, |           | (5 MCP tools,    |
          |  13 nodes)|           |  stdio transport) |
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

- All 37 user-addressable resource type constants and type definitions (35 with dedicated plugins + 2 compound-only that fall through to the generic plugin)
- Resource plugin registry (37 registered plugins: 35 type-specific + generic fallback; two compound-only types share the generic)
- Pattern template registry (9 compound architecture patterns + 1 variant)
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

- 13-node LangGraph pipeline (graph.ts + all nodes)
- Interactive wizard (option-elicitor with clack prompts)
- 17 Commander.js commands
- MCP server process management (spawn/lifecycle)
- AWS SDK integration (Bedrock, CloudControl, CloudFront, CloudWatch Logs, DynamoDB, EC2, IAM, Lambda, RDS, Resource Groups Tagging API, S3, SNS, SSM, STS)
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
| **Destroy**          | CloudControl + pre-delete hooks          | Strategy registry pattern                |
| **Drift**            | Full drift detection + reconciliation    | Not exposed as MCP tool                  |

### What MCP Server Reuses from CLI

The MCP server has a `"assignee": "workspace:*"` dependency, giving it access to:

- `createGraph()` function and all 13 nodes
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

| Server                                 | Package | Credential | Purpose                                                    |
| -------------------------------------- | ------- | ---------- | ---------------------------------------------------------- |
| `aws-pricing-mcp-server`               | uvx     | Reader     | Real-time AWS pricing data                                 |
| `aws-documentation-mcp-server`         | uvx     | None       | AWS documentation references                               |
| `iam-mcp-server`                       | uvx     | Auditor    | IAM permission simulation                                  |
| `billing-cost-management-mcp-server`   | uvx     | Reader     | Live billing data                                          |
| `well-architected-security-mcp-server` | uvx     | Auditor    | Post-provision security checks                             |
| `aws-knowledge-mcp-server`             | uvx     | None       | Remote knowledge (opt-in via ASSIGNEE_ENABLE_REMOTE_MCP=1) |

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

- Bedrock -- LLM inference (intent parsing, plan generation)
- CloudControl API -- resource CRUD + polling
- CloudFormation Registry -- schema DescribeType
- CloudFront -- distribution configuration (via CCAPI; legacy SDK post-provision hook deleted)
- CloudWatch Logs -- log group operations
- DynamoDB -- table operations
- EC2 -- AMI/VPC/subnet/SG/instance type discovery, EIP allocation, key pair management
- IAM -- setup command (user/policy/role creation)
- Lambda -- EventSourceMapping creation (via CCAPI; A6 migration removed SDK fallback)
- RDS -- database instance operations
- Resource Groups Tagging API -- resource listing
- S3 -- static site upload
- SNS -- Subscription creation (via CCAPI; A10 migration removed SDK fallback)
- SSM -- Parameter Store operations
- STS -- account identity for ARN construction
