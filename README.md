# Assignee.ai

[![CI](https://github.com/SergSlon/assignee-ai/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/SergSlon/assignee-ai/actions/workflows/ci.yml)
[![Cross-platform](https://github.com/SergSlon/assignee-ai/actions/workflows/ci-cross-platform.yml/badge.svg?branch=main)](https://github.com/SergSlon/assignee-ai/actions/workflows/ci-cross-platform.yml)
[![Coverage](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/SergSlon/f9d960dd5a1defd7b8fbd4656df40915/raw/assignee-ai-coverage.json)](https://github.com/SergSlon/assignee-ai/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20.11-brightgreen?logo=node.js)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript)](packages/typescript-config/strict.json)
[![pnpm](https://img.shields.io/badge/pnpm-workspaces-f69220?logo=pnpm)](pnpm-workspace.yaml)

> **AI-native cloud operator** — type AWS infrastructure intent in plain English, get a real, tagged, cost-estimated resource. No Terraform state, no CDK bootstrap, no console clicks. Human approval before every apply.

**Author:** Serhii L. &nbsp;·&nbsp; **Final project for the _Generative AI for Developers_ micro-master's program** (April 2026)

---

## Install & quick start

The workspace packages are `"private": true` — nothing is published to npm yet. Build from source and link the CLI into your `$PATH`:

```bash
git clone https://github.com/SergSlon/assignee-ai.git
cd assignee-ai
pnpm install
pnpm build
pnpm setup               # pnpm CLI's global-bin bootstrap (writes pnpm bin to $PATH). Reload shell after.
pnpm link --global        # adds 'assignee' to PATH

assignee dev setup       # creates operator / reader / auditor IAM users; writes .env (idempotent)
assignee admin doctor --short   # sanity-check credentials + Bedrock region
assignee infra plan "Create an S3 bucket named my-test-bucket"
```

> **Fallback (without global link):** `node apps/cli/dist/index.js <command>` works identically. You can also alias it: `alias assignee="node $(pwd)/apps/cli/dist/index.js"`.

For the full bootstrap walkthrough see [docs/how-to/quickstart.md](docs/how-to/quickstart.md) and [docs/aws-bootstrap.md](docs/aws-bootstrap.md). AWS SSO users: [docs/how-to/sso-authentication.md](docs/how-to/sso-authentication.md). MCP-server wire-up for Claude Code / Cursor / Windsurf: [docs/mcp-server.md](docs/mcp-server.md).

---

## First plan example

```console
$ assignee infra plan "Create an S3 bucket named hero-demo-bucket"
=== Plan ===
Resource Type:   AWS::S3::Bucket
Region:          us-east-1
Config:
  Bucket Name           hero-demo-bucket
  Block Public Access   All four flags: Yes
  Encryption            AES-256 (SSE-S3) enabled
  Versioning            Status: Enabled
Estimated Cost:  $0.0230/GB-month (live, AWS Pricing MCP)

Findings:        5 high, 5 medium (4 fixable)
  [HIGH]  S3 bucket should disable ACLs (BucketOwnerEnforced)
          → Fix: --set OwnershipControls=BucketOwnerEnforced
  [HIGH]  S3 bucket should enforce SSL-only requests
          → Manual: Add bucket policy to deny non-HTTPS requests
  💡 4 findings can be auto-fixed. Run `assignee dev init` to enable.

Apply now? (AWS::S3::Bucket, est. $0.0230/GB-month) ▸
```

---

## Commands at a glance

Full reference: [docs/commands.md](docs/commands.md).

| Workflow  | Commands (`assignee <group> <command>`)                     |
| :-------- | :---------------------------------------------------------- |
| Provision | `infra plan`, `infra apply`                                 |
| Manage    | `admin list`, `admin status`, `infra destroy`, `dev update` |
| Detect    | `infra drift`, `infra reconcile`                            |
| Optimise  | `infra optimize`                                            |
| Configure | `dev init`, `dev setup`, `admin doctor`                     |
| Audit     | `admin audit-verify`                                        |
| Restore   | `infra restore-provisions`                                  |
| Discover  | `admin describe`                                            |
| Shell     | `dev completions`, `dev version`                            |

---

## Configuration

Full reference: [docs/configuration.md](docs/configuration.md).

Most common env vars:

| Variable                              | Purpose                                              |
| :------------------------------------ | :--------------------------------------------------- |
| `ASSIGNEE_OPERATOR_ACCESS_KEY_ID`     | Least-privilege key for write operations             |
| `ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY` | Paired secret                                        |
| `AWS_REGION`                          | Target region (falls back to `us-east-1`)            |
| `ASSIGNEE_COST_CEILING_USD`           | Hard monthly cost ceiling — blocks apply above limit |
| `ASSIGNEE_VERBOSITY`                  | `verbose` to show JSON logs on stderr                |

Run `assignee dev init` to create a `.assignee/config.yaml` with region, tags, and auto-fix preferences. Run `assignee dev init --global` for user-wide defaults.

---

## Supported AWS resource types

Run `assignee infra plan --help` to discover all supported types and compound patterns in the running build. Full reference: [docs/resource-types.md](docs/resource-types.md).

---

## Compound patterns

Multi-resource intents detected by keyword matching at zero LLM latency, then provisioned in dependency order. Source of truth: [`packages/core/src/pattern-templates/index.ts`](packages/core/src/pattern-templates/index.ts).

| Pattern            | What it builds                                        | Trigger keywords                                  |
| :----------------- | :---------------------------------------------------- | :------------------------------------------------ |
| WebSocket API      | IAM Role → Lambda → LogGroup → API Gateway V2 (WS)    | "websocket api", "realtime api", "chat api"       |
| Serverless API     | IAM Role → Lambda → API Gateway V2 (HTTP)             | "serverless api", "lambda api"                    |
| Three-Tier Web     | VPC → Subnets → SG → ECS → ALB                        | "three tier", "web application"                   |
| Container Service  | ECR → ECS Cluster → IAM Role                          | "container service", "ecs"                        |
| Message Processing | SQS DLQ → SQS → DynamoDB → IAM Role → Lambda          | "message queue", "event processing"               |
| SQS with DLQ       | Primary SQS Queue + Dead-Letter Queue (RedrivePolicy) | "with dlq", "with dead-letter queue"              |
| SNS with Email     | SNS Topic + Email Subscription (Protocol=email)       | "with email subscription", "with subscriber"      |
| Static Website     | S3 + CloudFront + OAC + S3 upload                     | "static website", "static site"                   |
| EFS with VPC       | VPC + private subnets + NFS SG + FS + MountTargets    | "create an efs", "shared file system"             |
| VPC Networking     | VPC → Subnets → IGW → RouteTables → NAT               | "create a vpc", "vpc with subnets"                |
| VPC Public-Only    | VPC + public Subnets + IGW + Routes (free-tier)       | "vpc public only", "cheap vpc", "vpc without nat" |
| Scheduled Lambda   | IAM Role → Lambda → EventBridge Rule (cron)           | "scheduled lambda", "cron lambda"                 |
| Lambda + Exec Role | IAM Role → Lambda (minimal auto-exec-role)            | "create a lambda", "create a function"            |

---

## Troubleshooting

Exit codes, error-class playbook, and common remediation steps: [docs/troubleshooting.md](docs/troubleshooting.md).

---

## Documentation

Docs follow the [Diátaxis](https://diataxis.fr/) framework. Top-level entry point: [docs/index.md](docs/index.md).

**Get started**

| Topic                                                       | Where                                                                  |
| :---------------------------------------------------------- | :--------------------------------------------------------------------- |
| First ten minutes (install → init → plan → apply → destroy) | [docs/tutorials/getting-started.md](docs/tutorials/getting-started.md) |
| AWS account + IAM bootstrap end-to-end                      | [docs/aws-bootstrap.md](docs/aws-bootstrap.md)                         |
| Quickstart how-to (after bootstrap)                         | [docs/how-to/quickstart.md](docs/how-to/quickstart.md)                 |
| AWS SSO / Identity Center profiles                          | [docs/how-to/sso-authentication.md](docs/how-to/sso-authentication.md) |
| Read a plan box                                             | [docs/how-to/read-a-plan-box.md](docs/how-to/read-a-plan-box.md)       |
| Wire MCP server into Claude Code / Cursor / Windsurf        | [docs/mcp-server.md](docs/mcp-server.md)                               |

**Reference**

| Topic                                    | Where                                              |
| :--------------------------------------- | :------------------------------------------------- |
| Every CLI command + flag + exit code     | [docs/commands.md](docs/commands.md)               |
| Supported AWS resource types             | [docs/resource-types.md](docs/resource-types.md)   |
| Per-resource-type pages (auto-generated) | [docs/reference/](docs/reference/)                 |
| Configuration precedence + env vars      | [docs/configuration.md](docs/configuration.md)     |
| AWS MCP servers consumed by the pipeline | [docs/mcp-servers.md](docs/mcp-servers.md)         |
| Best-practice rule engine                | [docs/best-practices.md](docs/best-practices.md)   |
| Drift detection + reconcile              | [docs/drift-detection.md](docs/drift-detection.md) |
| Exit codes + error-class playbook        | [docs/troubleshooting.md](docs/troubleshooting.md) |

**Deep dive**

| Topic                                                                                  | Where                                                                                    |
| :------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------- |
| Monorepo layout + 15-node graph + hexagonal ports                                      | [docs/architecture.md](docs/architecture.md)                                             |
| End-to-end flow diagrams (plan / apply / destroy / drift)                              | [docs/architecture-flows.md](docs/architecture-flows.md)                                 |
| How CLI, MCP server, and `@assignee/core` fit together                                 | [docs/integration-architecture.md](docs/integration-architecture.md)                     |
| What the AI parts actually do (LLM callsites, MCP servers, BP engine, HITL)            | [docs/explanation/ai-architecture.md](docs/explanation/ai-architecture.md)               |
| Load-bearing invariants (partition-aware ARN, CCAPI NotFound, IAM safety allowlist, …) | [docs/explanation/invariants.md](docs/explanation/invariants.md)                         |
| Contributing a new BP rule (worked example)                                            | [docs/explanation/contributing-a-bp-rule.md](docs/explanation/contributing-a-bp-rule.md) |
| Testing strategy + how to run the suites                                               | [docs/testing-guide.md](docs/testing-guide.md)                                           |
| Audit log HMAC chain (verify, key rotation)                                            | [docs/how-to/audit-trail.md](docs/how-to/audit-trail.md)                                 |
| Operator runbook (incident response patterns)                                          | [docs/runbooks/incident-response.md](docs/runbooks/incident-response.md)                 |
| Competitor analyses (CDK + Q, Pulumi Neo, Terraform AI, kagent, SST, Nitric, Wing)     | [docs/explanation/competitors/](docs/explanation/competitors/)                           |

---

## Architecture

### The 15-node pipeline

```
User intent (CLI or MCP server)
        │
        ▼
   LangGraph 15-node DAG  ◀──▶  Amazon Nova Lite (Bedrock)
        │
        ▼
   5 AWS MCP servers (Pricing · Docs · IAM · WA-Security · Billing)
        │
        ▼
   AWS Cloud Control API  ──▶  Tagged resource
```

Nodes in source order ([`packages/core/src/graph/create-graph.ts`](packages/core/src/graph/create-graph.ts)):

```
intent_parser → schema_fetcher → option_elicitor → compound_dispatcher
  → plan_generator → validate_desired_state → advice_generator
  → preflight_guard → human_approval [HITL]
  → resource_provisioner → status_poller → bp_evaluator
  → fix_applicator → result_formatter → query_handler
```

Compound patterns loop `plan_generator → result_formatter` per resource in dependency order. `query_handler` serves QUERY_INTENT requests without entering the provision flow. Full architecture: [docs/architecture.md](docs/architecture.md).

### Components

| Component                | Choice                                                                | Why                                                                                                                                                                                     |
| :----------------------- | :-------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Orchestration**        | [`@langchain/langgraph`](https://langchain-ai.github.io/langgraphjs/) | Typed state machine; deterministic node routing; built-in HITL interrupts.                                                                                                              |
| **LLM (default)**        | `bedrock/amazon.nova-lite-v1:0`                                       | ~10× cheaper than GPT-4o for schema-shaped tasks; native CloudTrail audit via `bedrock:InvokeModel`.                                                                                    |
| **LLM gateway**          | [Vercel AI SDK](https://sdk.vercel.ai/)                               | Multi-provider (Bedrock / Anthropic / OpenAI / Google / Ollama) — operator can swap if Bedrock is unavailable.                                                                          |
| **Schema validation**    | Zod `.strict()` everywhere                                            | Hallucinated fields throw immediately; LLM self-corrects on the next turn.                                                                                                              |
| **AWS plane**            | Cloud Control API + 5 MCP servers                                     | One CRUD interface for ~1000 CFN types; MCP servers for pricing / docs / IAM / WA-Security / billing.                                                                                   |
| **Monorepo**             | Turborepo + pnpm workspaces                                           | `packages/core` is single-source for the graph and Zod schemas; CLI + MCP server import the same `createGraph()`.                                                                       |
| **Best-practice engine** | YAML rules + pure-function evaluator                                  | Each rule cites its source (FSBP, Well-Architected, AWS docs). Evaluation runs in <10 ms. Live count: [`packages/best-practices/manifest.json`](packages/best-practices/manifest.json). |
| **Memory**               | JSON files in `~/.assignee/`                                          | `provisions.json` (managed-resource registry), `failures.json` (mistake log), `patterns.json` (learned patterns). Local-first; HMAC-chained audit log.                                  |
| **Terminal UX**          | `@clack/prompts` + `chalk` + `boxen`                                  | Idiomatic clack wizard for the elicitor; box-drawn plan output that pastes cleanly into chat tools.                                                                                     |

**Repo layout (abbreviated):**

```
apps/cli            — Commander CLI; thin shim over @assignee/core
apps/mcp-server     — stdio MCP server; same createGraph() as the CLI
packages/core       — graph, nodes, ports, plugins, destroy strategies, pricing
packages/best-practices — YAML rule library + evaluation engine
```

**Safety sandwich.** Six independent guardrails wrap every apply: Zod-strict schemas, prompt-injection guard (Bedrock Guardrails), pre-flight cost circuit breaker, IAM least-privilege role separation, state guard (read-before-write rejects stale plans), and the HITL gate.

---

## How it differs from Terraform / CDK / Pulumi

|                          | Assignee.ai            | Terraform / CDK        | Pulumi Neo            | CDK + Amazon Q       |
| :----------------------- | :--------------------- | :--------------------- | :-------------------- | :------------------- |
| Code artifact            | **None**               | HCL + state            | Pulumi code + state   | CDK code + bootstrap |
| Pre-apply BP rules       | **Bundled YAML, free** | Sentinel (paid)        | CrossGuard (paid SKU) | cdk-nag add-on       |
| Plan-time cost preflight | **Live, blocking**     | Plugin / PR-comment    | Plugin                | Manual               |
| HITL approval gate       | **Built-in**           | None                   | None                  | None                 |
| Onboarding prereq        | Node + AWS creds       | TF CLI + state backend | Pulumi CLI + backend  | Node + cdk bootstrap |
| Agent surface (MCP)      | **Same graph as CLI**  | Provider MCPs (read)   | None bundled          | None                 |

These four properties — no code artifact, free BP rules, plan-time cost preflight, and HITL on both CLI and MCP surfaces — are the design intent of the bundle. The 15-node graph delivers all four through one shared pipeline.

> Comparison reflects bundled defaults of each tool's free / standard tier as of April 2026; paid SKUs and add-ons may close some gaps.

---

## Why this exists (vision · market · problem)

**The problem.** Cloud Ops is broken for the developer who is not a platform engineer. Multi-day provisioning cycles, senior-engineer time burned on routine infrastructure, and cloud spend wasted on misconfiguration and over-provisioning are endemic. Existing IaC tools (Terraform, Pulumi, CDK) require dedicated expertise — they define resources but don't _operate_ them.

**Target user — "Mara, the solo / small-team AWS operator."** A backend or full-stack engineer who inherited the AWS account. Uses Claude Code or Cursor; respects "local-first, my credentials never leave the box." Tried Terraform once and got stuck on state backends.

**Unique Value Proposition: constrained agency.** The LLM has zero inherent privilege. It _proposes_ desired state; the _system_ enforces IAM scope, cost ceiling, schema strictness, and best-practice gates. You don't trust the model — you trust the cage around it. Contrast: agentic CLIs that hand the model your AWS credentials and a shell — assignee.ai never does that, by design.

---

## Roadmap

| Window             | Phase                                            | Scope                                                                                                                     |
| :----------------- | :----------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------ |
| Feb 2026           | **Phase 0 — POC** ✅                             | CLI + LangGraph loop · Bedrock + Cloud Control · S3 / SSM / IAM Role                                                      |
| Mar – Apr 2026     | **Phase 1 — CLI-first MVP** ✅                   | Sprints A–E · `list` / `destroy` / `status` / `drift` / `reconcile` · intelligence layer · MCP server · cross-platform CI |
| **May – Jul 2026** | **Phase 2 — Distribution** _(next 3 months)_     | npm + Homebrew packages · GitHub Action · MCP-server registries · "Show HN" launch · onboarding polish                    |
| H2 2026 – H1 2027  | **Phase 3 — SaaS control plane** _(6–12 months)_ | Auth · org-wide policy engine · audit log · SSO/SAML · drift dashboard · Team / Enterprise tier features                  |
| 2027+              | **Phase 4 — Multi-cloud** _(post-traction)_      | Provider abstraction (GCP / Azure) once SAM penetration validates the AWS-only thesis                                     |

---

## Business model

| Tier                            | Audience                     | Includes                                                                                  |
| :------------------------------ | :--------------------------- | :---------------------------------------------------------------------------------------- |
| **Free CLI** _(MIT, this repo)_ | Solo operators / small teams | All resource types · compound patterns · best-practice library · JSON memory · MCP server |
| **Pro** _(future)_              | Power users                  | Unlimited plans · priority models · advanced patterns                                     |
| **Team** _(future SaaS)_        | Eng teams                    | Shared org policies · audit log · RBAC · drift dashboard                                  |
| **Enterprise** _(future SaaS)_  | Regulated buyers             | SSO/SAML · industry-aligned compliance posture · operational SLA · multi-cloud            |

The free CLI stays MIT-licensed forever. Distribution flywheel: free CLI adoption → MCP server distribution via Claude Code / Cursor / Windsurf → power users convert to paid → enterprise upsell on compliance and scale.

---

## Presentation

The course-submission pitch deck (10 slides, dark tech-talk theme):

- **Live**: <https://sergslon.github.io/assignee-ai/presentation/>
- **Source**: [presentation/index.html](presentation/index.html)

---

## License · Contributing · Security · Changelog

- **License:** MIT — see [LICENSE](LICENSE).
- **Changelog:** see [CHANGELOG.md](CHANGELOG.md).
- **Contributing:** see [CONTRIBUTING.md](CONTRIBUTING.md) for the dev loop and pre-commit gates.
- **Security:** see [SECURITY.md](SECURITY.md) for vulnerability reporting.
