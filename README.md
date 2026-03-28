# Assignee.ai

> AI-Native Cloud Operator — convert natural language into AWS infrastructure, safely.

```
assignee plan "Create an S3 bucket named my-app-assets"
assignee apply "Create an S3 bucket named my-app-assets"
assignee list
assignee status
assignee destroy my-bucket
assignee init
assignee completions
```

Also available as an [MCP server](#mcp-server) for AI coding agents (Claude Code, Cursor, Windsurf).

[![CI](https://github.com/SergSlon/assignee-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/SergSlon/assignee-ai/actions/workflows/ci.yml)
[![Coverage](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/SergSlon/f9d960dd5a1defd7b8fbd4656df40915/raw/assignee-ai-coverage.json)](https://github.com/SergSlon/assignee-ai/actions)

> **Note:** Both packages (`@assignee/cli` and `@assignee/mcp-server`) are `private: true` and not yet published to npm.

---

## How it works

1. **Plan** — describe intent in plain English; the LLM parses it, fetches the CloudFormation schema, evaluates best practices, and interactively elicits resource options before generating a validated `desiredState` JSON with a cost estimate
2. **Approve** — review the plan in the terminal and confirm (HITL)
3. **Apply** — Cloud Control API (or SDK fallback) provisions the resource; tags are injected, State Guard prevents stale-plan overwrites, status is polled until terminal state, and results are written to memory

```
intent_parser → schema_fetcher → option_elicitor → compound_dispatcher
  → plan_generator → bp_evaluator → fix_applicator → preflight_guard
    → human_approval ─[HITL]─ → resource_provisioner → status_poller → result_formatter
```

12 nodes. Compound patterns loop `plan_generator → result_formatter` per resource in dependency order.

All AI calls stay local — no AWS credentials ever leave your machine.

---

## Commands

| Command                       | Description                                    | Key flags                                                 |
| :---------------------------- | :--------------------------------------------- | :-------------------------------------------------------- |
| `assignee plan <intent>`      | Generate infrastructure plan                   | `--region`, `--json`                                      |
| `assignee apply <intent>`     | Plan + provision with HITL approval            | `--yes`, `--no-wizard`, `--checkpoint <path>`, `--region` |
| `assignee init`               | Initialize `.assignee/` project directory      | —                                                         |
| `assignee list`               | Show managed resources with cost               | `--region`, `--json`                                      |
| `assignee destroy <resource>` | Safe teardown with confirmation                | `--yes`                                                   |
| `assignee status`             | Intelligence summary (memory, findings, costs) | `--json`                                                  |
| `assignee setup`              | Automate IAM role/policy creation              | —                                                         |
| `assignee completions`        | Generate shell completions (bash/zsh)          | —                                                         |

---

## Quick start

### Prerequisites

- Node.js 22+
- pnpm 10+
- Python 3.10+ with `uvx` (`pip install uv`)
- Three IAM users with the policies below (full setup: [docs/aws-bootstrap.md](docs/aws-bootstrap.md))

### Install

```bash
pnpm install
pnpm build
```

### Configure

```bash
cp .env.example .env
# Fill in AWS credentials — see .env.example for field descriptions
```

### Run

```bash
# Plan only (no AWS resources created)
node apps/cli/dist/index.js plan "Create an S3 bucket named my-test-bucket"

# Plan + apply with HITL confirmation
node apps/cli/dist/index.js apply "Create an S3 bucket named my-test-bucket"

# Expert mode: skip wizard, auto-approve
node apps/cli/dist/index.js apply --no-wizard --yes "Create an S3 bucket"

# Resume from checkpoint
node apps/cli/dist/index.js apply --checkpoint ~/.assignee/checkpoints/abc123.json
```

---

## Supported resource types

15 CCAPI types + 2 SDK-routable fallback types = 17 total:

| Type                                        | Notes                                                      |
| :------------------------------------------ | :--------------------------------------------------------- |
| `AWS::S3::Bucket`                           | Interactive prompts: encryption, versioning, public access |
| `AWS::SSM::Parameter`                       |                                                            |
| `AWS::IAM::Role`                            | Cost: Free                                                 |
| `AWS::EC2::Instance`                        | Interactive prompts: instance type with live $/hr pricing  |
| `AWS::RDS::DBInstance`                      | Interactive prompts: engine, class with live $/hr pricing  |
| `AWS::Lambda::Function`                     | Interactive prompts: runtime, handler, memory, timeout     |
| `AWS::EC2::VPC`                             |                                                            |
| `AWS::EC2::Subnet`                          |                                                            |
| `AWS::EC2::SecurityGroup`                   |                                                            |
| `AWS::DynamoDB::Table`                      |                                                            |
| `AWS::SQS::Queue`                           |                                                            |
| `AWS::SNS::Topic`                           |                                                            |
| `AWS::ElasticLoadBalancingV2::LoadBalancer` |                                                            |
| `AWS::ECS::Cluster`                         |                                                            |
| `AWS::ECR::Repository`                      |                                                            |
| `AWS::Lambda::EventSourceMapping`           | SDK fallback (not CCAPI)                                   |
| `AWS::SNS::Subscription`                    | SDK fallback (not CCAPI)                                   |

### Compound architecture patterns

Multi-resource intents are detected by keyword matching (zero LLM latency) and provisioned in dependency order:

| Pattern            | Resources                                    | Trigger keywords                    |
| :----------------- | :------------------------------------------- | :---------------------------------- |
| Serverless API     | IAM Role → Lambda → DynamoDB → API Gateway   | "serverless api", "lambda api"      |
| Static Website     | S3 Bucket (website-configured)               | "static website", "static site"     |
| Message Processing | SQS DLQ → SQS + DynamoDB + IAM Role → Lambda | "message queue", "event processing" |
| Three-Tier Web     | VPC → Subnet → SecurityGroup → ECS → ALB     | "three tier", "web application"     |
| Container Service  | ECR → ECS Cluster → IAM Role                 | "container service", "ecs"          |

---

## MCP Server

The `@assignee/mcp-server` package exposes assignee.ai as an MCP server for AI coding agents. Tools: `plan_resource`, `apply_plan`, `list_managed_resources`, `estimate_cost`.

Works with Claude Code, Cursor, and Windsurf. See [apps/mcp-server/README.md](apps/mcp-server/README.md) for setup instructions.

---

## Architecture

```
apps/
  cli/
    src/
      commands/        plan.ts · apply.ts · init.ts · list.ts · destroy.ts
                       status.ts · completions.ts
      nodes/           intent-parser · schema-fetcher · option-elicitor
                       compound-dispatcher · plan-generator · bp-evaluator
                       fix-applicator · preflight-guard · human-approval
                       resource-provisioner · status-poller · result-formatter
      services/        graph.ts (LangGraph) · mcp-client.ts · memory.ts
                       list-resources.ts · resource-resolver.ts · billing.ts
                       status-aggregator.ts · litellm-adapter.ts
      config/          mcp-servers.ts
      utils/           display.ts · logger.ts · tags.ts · mcp.ts · pricing-lookup.ts
      test-fixtures/   mcp-mock-responses.ts (real MCP captures)
    scripts/           capture → process → build fixture pipeline
  mcp-server/
    src/               MCP server entry point, tool handlers
packages/
  core/
    src/
      schema/          graph-state.ts (Zod) · memory.ts
      types/           result.ts (Result<T,E> monad)
      config/          resource-types.ts · resource-identifiers.ts · resource-policy.ts
      resource-plugins/  types.ts · registry.ts · index.ts
                         plugins/  s3-bucket · ec2-instance · rds-dbinstance
                                   lambda-function · generic
      pattern-templates/ registry.ts · types.ts
                         patterns/ serverless-api · static-website · message-processing
                                   three-tier-web · container-service
      pricing/         pricing data and lookup
      guardrails/      built-in guardrail rules
      errors.ts
  best-practices/
    src/               BP YAML schema, trigger engine, rule library
```

**Key dependencies:**

- [`@langchain/langgraph`](https://langchain-ai.github.io/langgraphjs/) — agentic workflow orchestration
- [`ai`](https://sdk.vercel.ai/) + [`@ai-sdk/amazon-bedrock`](https://sdk.vercel.ai/providers/ai-sdk-providers/amazon-bedrock) — Vercel AI SDK
- [`@ai-sdk/anthropic`](https://sdk.vercel.ai/providers/ai-sdk-providers/anthropic), [`@ai-sdk/openai`](https://sdk.vercel.ai/providers/ai-sdk-providers/openai), [`@ai-sdk/google`](https://sdk.vercel.ai/providers/ai-sdk-providers/google) — multi-provider LLM support
- [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/sdk) — MCP server SDK
- [`@langchain/mcp-adapters`](https://github.com/langchain-ai/langchainjs/tree/main/libs/langchain-mcp-adapters) — MCP server bridge
- [`@clack/prompts`](https://github.com/bombshell-dev/clack) + `chalk` + `boxen` — terminal UX

**MCP servers (spawned at runtime via `uvx`):**

| Server                                         | Purpose                                  |
| :--------------------------------------------- | :--------------------------------------- |
| `awslabs.cfn-mcp-server`                       | CloudFormation schemas (plan validation) |
| `awslabs.aws-pricing-mcp-server`               | Live cost estimates                      |
| `awslabs.aws-documentation-mcp-server`         | AWS doc search and reads                 |
| `awslabs.iam-mcp-server`                       | IAM policy analysis (read-only)          |
| `awslabs.well-architected-security-mcp-server` | Well-Architected security pillar         |
| `awslabs.cost-and-usage-mcp-server`            | Billing and cost management              |

Optional servers (IAM, Well-Architected Security, Billing) are spawned only when the corresponding command requires them.

> **Note:** CCAPI provisioning migrated from `ccapi-mcp-server` to `@aws-sdk/client-cloudcontrol` SDK (Story 7.6).

**LLM provider:** Default `us.amazon.nova-lite-v1:0` (Bedrock). Override with `ASSIGNEE_MODEL=anthropic/claude-haiku-4-5` or any LiteLLM-compatible string (OpenAI, Google, Anthropic).

**Credential separation:**

- `ASSIGNEE_OPERATOR_*` env vars → operator IAM user → Bedrock AI calls + CloudFormation provisioning
- `ASSIGNEE_READER_*` env vars → reader IAM user → MCP servers with read-only access (CCAPI, pricing)
- `ASSIGNEE_AUDITOR_*` env vars → auditor IAM user → MCP servers with audit access (CloudFormation describe/list)

---

## Development

```bash
pnpm test          # 1171 tests across 65 files
pnpm check-types   # TypeScript type check
pnpm build         # compile all packages
```

Pre-commit hook runs: prettier → check-types → test.

### Test fixtures

All MCP mock responses in `apps/cli/src/test-fixtures/mcp-mock-responses.ts` are captured from live MCP servers (not fabricated). Captured responses are tracked in git. To refresh:

```bash
cd apps/cli/scripts
node capture-mcp-responses.mjs    # requires .env with ASSIGNEE_READER_* and ASSIGNEE_AUDITOR_* credentials
node process-captured-responses.mjs
node build-fixture-ts.mjs
```

---

## Project status

### Completed epics

| Epic   | Description                                                                       | Status                                      |
| :----- | :-------------------------------------------------------------------------------- | :------------------------------------------ |
| **0**  | Project Foundation & Monorepo Setup                                               | Done                                        |
| **1**  | Plan Command (LangGraph, MCP, intent parsing, plan generation)                    | Done                                        |
| **2**  | Apply Command (HITL, provisioning, status polling, tagging)                       | Done                                        |
| **7**  | Resource Intelligence (17 types, option elicitation, pricing, doc hints)          | Done                                        |
| **8**  | Compound Provisioning (5 architecture patterns, dependency ordering)              | Done                                        |
| **9**  | Architecture Hardening (type safety, error handling, prompt injection guard)      | Done                                        |
| **10** | Plan Intelligence & Checkpoint (save/resume, guardrails, plan-to-apply)           | Done                                        |
| **11** | Expert Apply Mode (`--yes`, `--no-wizard`, `--checkpoint`)                        | Done                                        |
| **12** | Best Practices Library (YAML schema, trigger engine, 45+ rules, FSBP)             | In progress (12.4, 12.6 remaining)          |
| **14** | LiteLLM Provider Gateway (multi-provider LLM support)                             | In progress (14.1 done; 14.2-14.4 deferred) |
| **18** | CLI Polish & Distribution (init, list, destroy, completions, npm/brew, GH Action) | Done                                        |
| **19** | Intelligence Layer (IAM MCP, WA Security MCP, memory system, status, billing)     | Done                                        |
| **20** | MCP Server (plan, apply, list, estimate tools for AI agents)                      | Done                                        |
| **22** | Auto-Fix Round (apply auto-fixable BP patches with user consent)                  | Done                                        |
| **23** | Real-Time Pricing Breakdown (live pricing via AWS Pricing MCP, zero hardcoded $)  | Done                                        |

### Deferred epics (post-traction / SaaS phase)

| Epic   | Description                                         |
| :----- | :-------------------------------------------------- |
| **3**  | Auth & Identity (browser OIDC, user/org ID)         |
| **4**  | Policy & Governance (SaaS policy engine, cost caps) |
| **5**  | Team & Spend (admin invites, spend dashboard)       |
| **6**  | Audit & Compliance (WORM log, X-Ray, cost anomaly)  |
| **13** | Provider Abstraction (cloud-agnostic ports)         |
| **15** | `assignee advice` command (multi-skill analysis)    |
| **16** | SKILL.md Extensibility (plugin system)              |
| **17** | Config Cascade & Profiles                           |

---

## AWS setup

See [docs/aws-bootstrap.md](docs/aws-bootstrap.md) for the full IAM policy setup, Bedrock logging, and CloudWatch log group configuration.

**Quick start:** `assignee setup` automates IAM role/policy creation. For manual setup, follow the guide.

---

## Documentation

| Document                 | Scope               | Location                                                                             |
| ------------------------ | ------------------- | ------------------------------------------------------------------------------------ |
| Architecture Flows       | CLI (current)       | [docs/architecture-flows.md](docs/architecture-flows.md)                             |
| AWS Setup Guide          | CLI (current)       | [docs/aws-bootstrap.md](docs/aws-bootstrap.md)                                       |
| Testing Guide            | CLI (current)       | [docs/testing-guide.md](docs/testing-guide.md)                                       |
| CLI Architecture         | CLI (authoritative) | [planning: cli-architecture.md](_bmad-output/planning-artifacts/cli-architecture.md) |
| Full Vision Architecture | SaaS (deferred)     | [planning: architecture.md](_bmad-output/planning-artifacts/architecture.md)         |
| Product Requirements     | Both                | [planning: prd.md](_bmad-output/planning-artifacts/prd.md)                           |
| Epics & Stories          | Both                | [planning: epics.md](_bmad-output/planning-artifacts/epics.md)                       |
