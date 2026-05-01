---
diataxis: explanation
canonical: true
---

> **Diátaxis: Explanation** — This is the canonical root page for this topic. Background on how the CLI, MCP server, and `@assignee/core` fit together.

# Assignee.ai -- Integration Architecture

> Reverse-engineered from source code, April 2026.

## Overview

Assignee.ai has three primary packages that integrate with each other:

```
                    +-------------------+
                    |   @assignee/core  |
                    | (types, plugins,  |
                    |  pricing, config, |
                    |  graph, nodes)    |
                    +-------------------+
                       /             \
                      /               \
          +-----------+           +------------------+
          |  apps/cli |           | apps/mcp-server  |
          | (13 cmds, |           | (5 MCP tools,    |
          |  shim     |           |  stdio transport) |
          |  nodes)   |           |                  |
          +-----------+           +------------------+
               |                         |
               |  depends on             |  depends on
               v                         v
    +--------------------+    +--------------------+
    | @assignee/best-    |    | @assignee/core +   |
    | practices          |    | @assignee/best-    |
    |                    |    | practices (no CLI) |
    +--------------------+    +--------------------+
```

**Wave-5 invariant:** `apps/mcp-server` no longer depends on the
`assignee` (CLI) workspace package at runtime. Both apps now import
`createGraph` and all node implementations directly from
`@assignee/core/graph`.

## What Lives Where

### @assignee/core (`packages/core/`)

The shared foundation. Contains **zero business logic** -- only types, data, and pure functions.

**Provides to both CLI and MCP server:**

- All 38 user-addressable resource type constants and type definitions (36 with dedicated plugins + 2 compound-only that fall through to the generic plugin)
- Resource plugin registry (38 registered plugins: 36 type-specific + generic fallback; two compound-only types share the generic)
- Pattern template registry (11 compound architecture patterns)
- Pricing strategy registry (38 strategies) and decomposer registry (38 decomposers)
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
- Hexagonal ports: `CheckpointerPort`, `AdvisoryLockPort`, `TelemetryPort`, `OIDCPort` (adapters in the same package)
- Audit log (`packages/core/src/audit/`) — HMAC-chain, verifier, per-tenant key
- RBAC scaffolding (`packages/core/src/rbac/`) — Zod policy schema, in-memory + file adapters, five fixtures
- Partition-aware provisioner (`packages/core/src/provisioning/`) — CCAPI partition matrix + SDK-direct routing for GovCloud/China/ISO
- Telemetry spans (`packages/core/src/telemetry/spans.ts`) — per-graph-node entry/exit spans for 13/14 nodes
- OTEL source-side allowlist (`packages/core/src/telemetry/otel-allowlist.ts`) — `OTEL_FIELD_ALLOWLIST` with `@privacy` classification and W1 sensitive-field scrub composition

### CLI (`apps/cli/`)

The primary user-facing application. Contains all business logic.

**Unique to CLI:**

- 13-node LangGraph pipeline (graph.ts + all nodes)
- Interactive wizard (option-elicitor with clack prompts)
- 13 Commander.js commands
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

Both CLI and MCP server use the **same LangGraph pipeline**, whose canonical definition lives in `packages/core/src/graph/create-graph.ts`. The MCP server imports `createGraph()` **directly from `@assignee/core/graph`** — the Wave-5 Pass I refactor inverted the earlier dependency, so the MCP server no longer needs a runtime import of the CLI package. The CLI keeps a thin re-export shim at `apps/cli/src/services/graph.ts` for backward compatibility with internal import paths, but there is no code-level coupling from MCP to CLI for the graph itself.

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

### What MCP Server Reuses from `@assignee/core`

The MCP server's only workspace runtime deps are `@assignee/core` and
`@assignee/best-practices` (the `"assignee": "workspace:*"` runtime dep
was removed in Story 50-4 Wave 5 Pass I). Through `@assignee/core` the
MCP server accesses:

- `createGraph()` and every node implementation (all 14 nodes live
  under `packages/core/src/graph/nodes/`; `apps/cli/src/nodes/` is
  shim-only)
- `CloudControlAdapter` (Story 50-7 inlined the former SDKFallbackDispatcher redirect classifier)
- `MemoryService` for provision/failure recording
- `fetchManagedResources()` for resource listing
- Display utilities (the MCP server formats differently but shares the
  underlying formatting primitives)
- Checkpoint serialization functions
- The shared destroy-strategies registry under
  `packages/core/src/destroy-strategies/` (replaces the pre-Wave-5
  per-app registries)

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
