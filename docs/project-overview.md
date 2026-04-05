# Assignee.ai -- Project Overview

> Reverse-engineered from source code, April 2026.

## What Assignee.ai Is

Assignee.ai is an **AI-native cloud infrastructure operator** that provisions, manages, and governs AWS resources using natural language. Users describe what they want in plain English (e.g., "Create an S3 bucket for static website hosting"), and Assignee.ai plans, validates, prices, and provisions the resource through a 12-node LangGraph pipeline backed by LLM intelligence.

The tool operates as a CLI (`assignee`) and as an MCP server (`@assignee/mcp-server`) that exposes the same capabilities to AI coding assistants (Cursor, Claude Code, Windsurf).

## Core Capabilities

### 1. Natural Language to Infrastructure

Users express infrastructure intent in natural language. The system classifies the intent, fetches the CloudFormation schema, elicits configuration through an interactive wizard, generates a CloudFormation-compatible desired state, evaluates best practices, estimates costs, and provisions via the AWS CloudControl API.

### 2. 23 Supported AWS Resource Types

**Tier 0 (Original):**

- S3 Bucket, SSM Parameter, IAM Role, EC2 Instance, RDS DBInstance, Lambda Function

**Tier 1 (Compound pattern support):**

- VPC, Subnet, Security Group, DynamoDB Table, SQS Queue, SNS Topic, ELBv2 Load Balancer, ECS Cluster, ECR Repository

**Tier 1 (Networking):**

- Logs LogGroup, Internet Gateway, Route Table, Route, NAT Gateway

**Tier 2:**

- API Gateway V2, CloudWatch Alarm, Secrets Manager Secret

**CCAPI Fallback Types (SDK-routed):**

- Lambda EventSourceMapping, SNS Subscription

**Companion-only (auto-provisioned):**

- EC2 EIP, VPC Gateway Attachment, Secrets Manager Target Attachment, Subnet Route Table Association, API Gateway V2 Integration/Route/Stage, Lambda Permission

### 3. 7 Compound Architecture Patterns

Multi-resource patterns detected from natural language with zero LLM latency:

| Pattern ID           | Resources Created                                 |
| -------------------- | ------------------------------------------------- |
| `serverless-api`     | Lambda + API Gateway + IAM Role + DynamoDB        |
| `three-tier-web`     | VPC + Subnets + Security Groups + ELB + EC2 + RDS |
| `container-service`  | ECR + ECS Cluster + IAM Role + ELB                |
| `message-processing` | SQS + SNS + Lambda + IAM Role                     |
| `static-website`     | S3 + CloudFront (post-provision)                  |
| `vpc-networking`     | VPC + Subnets + IGW + NAT Gateway + Route Tables  |
| `vpc-public-only`    | VPC + Public Subnets + IGW + Route Tables         |

### 4. The 12-Node LangGraph Pipeline

```
START
  |
  v
intent_parser ------> schema_fetcher ------> option_elicitor
                                                    |
                                                    v
                                          compound_dispatcher
                                                    |
                                                    v
                                           plan_generator
                                                    |
                                                    v
                                           bp_evaluator
                                                    |
                                                    v
                                          fix_applicator
                                                    |
                                                    v
                                          preflight_guard
                                                    |
                                         /          |          \
                                        v           v           v
                               human_approval  result_formatter  resource_provisioner
                                        |                              |
                                        v                              v
                              resource_provisioner              status_poller (self-loop)
                                        |                              |
                                        v                              v
                                  status_poller               result_formatter ---> END
                                        |                              |
                                        v                       (compound loop)
                                 result_formatter                      |
                                        |                              v
                                       END                      plan_generator
```

**Node descriptions:**

1. **intent_parser** -- Classifies natural language into a resource type or compound pattern. Uses LLM (Bedrock/Anthropic/OpenAI/Google/Ollama) for single resources; pattern detection is zero-latency regex-based.
2. **schema_fetcher** -- Fetches the CloudFormation Registry schema for the identified resource type via AWS SDK (`DescribeType`).
3. **option_elicitor** -- Interactive wizard that collects configuration from the user. Enriches options with live AWS pricing from MCP, discovers resources (AMIs, VPCs, subnets), applies 6-level config precedence, shows best-practice hints.
4. **compound_dispatcher** -- Routes between single-resource and compound paths. For compound patterns, flattens dependency order into a sequential queue.
5. **plan_generator** -- Generates CloudFormation desired state. For single resources, calls LLM. For compound resources, uses pattern defaults. Merges wizard answers, applies toCfn transforms, sanitizes, repairs required fields, resolves AMIs.
6. **bp_evaluator** -- Evaluates 136 YAML-defined best practice rules against the planned configuration. Produces findings with severity (CRITICAL/HIGH/MEDIUM/LOW).
7. **fix_applicator** -- Applies auto-fixable best practice patches to desired state. Respects user's explicit wizard choices. Supports auto/ask/skip modes and interactive fixes.
8. **preflight_guard** -- Cost estimation gate + validation. Queries AWS Pricing MCP for real-time costs, runs pricing decomposer for line-item breakdowns, checks IAM permissions, evaluates free-tier eligibility, blocks on CRITICAL BP findings.
9. **human_approval** -- HITL confirmation. Shows plan box, prompts for approval. Supports `--yes` for CI/CD auto-approval. Plan-to-apply flow skips redundant confirmation.
10. **resource_provisioner** -- Provisions via CloudControl API. Implements State Guard (read-before-write), SDK fallback for CCAPI gap types, EIP allocation for NAT Gateway, SSH key pair creation for EC2, mandatory tag injection.
11. **status_poller** -- Polls CloudControl for async operation status. Self-loops every 2s. 5-minute timeout (15 min for RDS/ELB/NAT Gateway).
12. **result_formatter** -- Final rendering. Shows success/failure output, runs post-provision security checks, records to memory, handles compound resource loop, uploads static site files.

### 5. CLI Commands

| Command                       | Description                                                                 |
| ----------------------------- | --------------------------------------------------------------------------- |
| `assignee plan <intent>`      | Generate and display an infrastructure plan (no provisioning)               |
| `assignee apply <intent>`     | Plan + provision with HITL approval                                         |
| `assignee destroy <resource>` | Destroy a managed resource (single or `--all` bulk)                         |
| `assignee list`               | List all managed resources (tagged `managed-by=assignee-ai`)                |
| `assignee status`             | Infrastructure summary with cost totals, `--bp-coverage` dashboard          |
| `assignee drift`              | Check managed resources for configuration drift                             |
| `assignee reconcile`          | Reconcile drifted resources (restore/accept/skip)                           |
| `assignee init`               | Create `.assignee/config.yaml` (project or `--global` user)                 |
| `assignee setup`              | Create IAM users/policies for 3-user credential model                       |
| `assignee cache`              | Manage CloudFormation schema cache (`clear`/`refresh`)                      |
| `assignee clean`              | Prune expired checkpoints, cache, and memory; `--resources` for AWS cleanup |
| `assignee completions`        | Generate shell completions (bash/zsh/fish)                                  |

### 6. MCP Server (5 Tools)

Exposes assignee capabilities to AI coding assistants via Model Context Protocol:

| Tool                     | Description                                        |
| ------------------------ | -------------------------------------------------- |
| `plan_resource`          | Generate infrastructure plan from natural language |
| `apply_plan`             | Apply a previously generated plan                  |
| `list_managed_resources` | List all managed AWS resources                     |
| `estimate_cost`          | Estimate monthly cost for a resource               |
| `destroy_resource`       | Safely destroy a managed resource                  |

### 7. Best Practices Engine

136 YAML rules across 16 AWS service categories (S3, EC2, RDS, Lambda, IAM, DynamoDB, VPC, SQS, SNS, ECS, ECR, ELBv2, Logs, CloudWatch, Secrets Manager, SSM, API Gateway, Autoscaling). Each rule defines:

- Severity (CRITICAL/HIGH/MEDIUM/LOW)
- Check type (equals, exists, not_exists, contains, regex, comparison)
- Auto-fix patches (desiredStatePatch)
- Interactive fix options
- Source references (AWS Security Hub FSBP, CIS, Well-Architected)

Enforcement levels: `enforce` (block on critical), `warn` (advisory), `skip`.

### 8. Pricing Engine

Every resource type has:

- A **pricing strategy** that builds MCP query configs and provides local fallback estimates
- A **pricing decomposer** that breaks costs into line items (compute, storage, I/O, data transfer)

Prices are fetched at runtime from the AWS Pricing API via MCP server. Price cache with TTL reduces redundant queries.

### 9. Configuration System (6-Level Precedence)

From highest to lowest: 0. Org locked / Org always_ask (overrides everything)

1. CLI flags (`--set key=value`)
2. Env var overrides (`ASSIGNEE_*`)
3. Project config (`.assignee/config.yaml`)
4. User config (`~/.config/assignee/config.yaml`)
5. Org default
6. Plugin default

### 10. Memory System

JSON-file backed persistence in `~/.assignee/memory/`:

- **Provision log** -- records successful provisions with costs, used for memory hints
- **Failure log** -- records failures with suggested fixes, used for warning hints
- **Pattern log** -- tracks compound pattern usage frequency

### 11. Credential Model (3-User Separation)

| User     | Purpose                                 | Env Prefix            |
| -------- | --------------------------------------- | --------------------- |
| Operator | CloudControl provisioning + Bedrock LLM | `ASSIGNEE_OPERATOR_*` |
| Reader   | Schema/pricing/billing MCP servers      | `ASSIGNEE_READER_*`   |
| Auditor  | IAM/SecurityHub MCP servers             | `ASSIGNEE_AUDITOR_*`  |

### 12. LLM Provider Support

Via Vercel AI SDK, configured through `ASSIGNEE_MODEL` env var:

- `bedrock/amazon.nova-lite-v1:0` (default)
- `anthropic/claude-sonnet-4-5`
- `openai/gpt-4o`
- `google/gemini-2.0-flash`
- `ollama/llama3` (OpenAI-compatible endpoint)

### 13. Drift Detection and Reconciliation

- Compares desired state (from provision logs) against actual state (CloudControl GetResource)
- Deep diff with type normalization for AWS quirks
- Supports concurrent drift checks with progress bar
- Reconcile modes: restore to desired, accept current as new desired, skip
- Auto-reconcile for CI/CD

### 14. Checkpoint System

Plans are saved as JSON checkpoints in `.assignee/` with:

- Sensitive field redaction (passwords, secrets, tokens)
- TTL-based expiration
- Plan-to-apply flow (plan, review, then apply later from checkpoint)
- Version compatibility checking

### 15. Recording System

`ASSIGNEE_RECORD=1` captures all external API calls (MCP, AWS SDK, LLM) to JSON fixtures for testing. Zero overhead when disabled.

### 16. Telemetry

Structured JSON logging to stderr. Timing module for performance tracking.

### 17. First-Run Experience

Auto-detects first run (no `~/.assignee/`), creates directory structure, shows welcome message. Supports `npx` quick start.
