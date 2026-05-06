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

## 1. Problem & Market

**The problem.** Cloud Ops is broken for the developer who is not a platform engineer. Industry surveys consistently report multi-day provisioning cycles for a single managed database, a sizable share of senior-engineer time burned on routine infrastructure, and several billion dollars of annual cloud spend wasted on misconfiguration and over-provisioning (see Flexera State of the Cloud 2024 and the DORA / Stack Overflow developer surveys for the underlying figures). Existing IaC tools (Terraform, Pulumi, CDK) require dedicated expertise — they define resources but don't _operate_ them, and a new hire cannot safely deploy production infra without mentorship.

**Target user — "Mara, the solo / small-team AWS operator."** A backend or full-stack engineer who inherited the AWS account. 2–8 years of experience, writes Python and TypeScript, does NOT write HCL or Pulumi day-to-day. Runs a side project or small production account (1–10 engineers, under $10k/mo AWS bill). Tried Terraform once and got stuck on state backends; tried CDK and got stuck on bootstrap. Uses Claude Code or Cursor; respects "local-first, my credentials never leave the box."

**Market sizing _(indicative — derived from public industry surveys; not a committed forecast for the course-submission build)_.**

| Layer   | Figure      | Definition                                                                        |
| :------ | :---------- | :-------------------------------------------------------------------------------- |
| **TAM** | **$50–60B** | Cloud Management Platforms (order-of-magnitude, per Gartner CMP market estimates) |
| **SAM** | **$5–10B**  | DevOps automation tooling subset                                                  |
| **SOM** | **~$100M**  | SMB / mid-market reachable in Years 1–3 (order-of-magnitude)                      |

---

## 2. Solution

**Infrastructure-as-Intent.** The CLI parses plain English, fetches the live CloudFormation schema, runs an interactive wizard, evaluates the bundled best-practice rule library, prices the result against the AWS Pricing API, and gates the apply behind a human "yes." Resources land tagged in your AWS account; there is no source file to maintain and no state backend to host.

```console
$ assignee plan "Create an S3 bucket named hero-demo-bucket"
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
  💡 4 findings can be auto-fixed. Run `assignee init` to enable.

Apply now? (AWS::S3::Bucket, est. $0.0230/GB-month) ▸
```

**Unique Value Proposition: constrained agency.** The LLM has zero inherent privilege. It _proposes_ desired state; the _system_ enforces IAM scope, cost ceiling, schema strictness, and best-practice gates. You don't trust the model — you trust the cage around it. Contrast: agentic CLIs that hand the model your AWS credentials and a shell — assignee.ai never does that, by design.

**Key differences from existing solutions:**

|                          | Assignee.ai            | Terraform / CDK        | Pulumi Neo            | CDK + Amazon Q       |
| :----------------------- | :--------------------- | :--------------------- | :-------------------- | :------------------- |
| Code artifact            | **None**               | HCL + state            | Pulumi code + state   | CDK code + bootstrap |
| Pre-apply BP rules       | **Bundled YAML, free** | Sentinel (paid)        | CrossGuard (paid SKU) | cdk-nag add-on       |
| Plan-time cost preflight | **Live, blocking**     | Plugin / PR-comment    | Plugin                | Manual               |
| HITL approval gate       | **Built-in**           | None                   | None                  | None                 |
| Onboarding prereq        | Node + AWS creds       | TF CLI + state backend | Pulumi CLI + backend  | Node + cdk bootstrap |
| Agent surface (MCP)      | **Same graph as CLI**  | Provider MCPs (read)   | None bundled          | None                 |

These four properties — no code artifact, free BP rules, plan-time cost preflight, and HITL on both CLI and MCP surfaces — are the design intent of the bundle. A tool with three of the four lands closer to one of the existing categories above; assignee.ai ships all four through one shared 14-node graph.

> Comparison reflects bundled defaults of each tool's free / standard tier as of April 2026; paid SKUs and add-ons may close some gaps.

---

## 3. Technical Architecture

### The LangGraph ↔ MCP pipeline

```
User intent (CLI or MCP server)
        │
        ▼
   LangGraph 14-node DAG  ◀──▶  Amazon Nova Lite (Bedrock)
        │
        ▼
   5 AWS MCP servers (Pricing · Docs · IAM · WA-Security · Billing)
        │
        ▼
   AWS Cloud Control API  ──▶  Tagged resource
```

```
intent_parser → schema_fetcher → option_elicitor → compound_dispatcher
  → plan_generator → validate_desired_state → advice_generator
  → bp_evaluator → fix_applicator → preflight_guard → human_approval ─[HITL]─
  → resource_provisioner → status_poller → result_formatter
```

Source of truth: [`packages/core/src/graph/create-graph.ts`](packages/core/src/graph/create-graph.ts). Compound patterns loop `plan_generator → result_formatter` per resource in dependency order.

### Compound architecture patterns

Multi-resource intents detected by keyword matching at zero LLM latency, then provisioned in dependency order. Source of truth: [`packages/core/src/pattern-templates/index.ts`](packages/core/src/pattern-templates/index.ts).

| Pattern            | What it builds                                     | Trigger keywords                                  |
| :----------------- | :------------------------------------------------- | :------------------------------------------------ |
| WebSocket API      | IAM Role → Lambda → LogGroup → API Gateway V2 (WS) | "websocket api", "realtime api", "chat api"       |
| Serverless API     | IAM Role → Lambda → API Gateway V2 (HTTP)          | "serverless api", "lambda api"                    |
| Three-Tier Web     | VPC → Subnets → SG → ECS → ALB                     | "three tier", "web application"                   |
| Container Service  | ECR → ECS Cluster → IAM Role                       | "container service", "ecs"                        |
| Message Processing | SQS DLQ → SQS → DynamoDB → IAM Role → Lambda       | "message queue", "event processing"               |
| Static Website     | S3 + CloudFront + OAC + S3 upload                  | "static website", "static site"                   |
| EFS with VPC       | VPC + private subnets + NFS SG + FS + MountTargets | "create an efs", "shared file system"             |
| VPC Networking     | VPC → Subnets → IGW → RouteTables → NAT            | "create a vpc", "vpc with subnets"                |
| VPC Public-Only    | VPC + public Subnets + IGW + Routes (free-tier)    | "vpc public only", "cheap vpc", "vpc without nat" |
| Scheduled Lambda   | IAM Role → Lambda → EventBridge Rule (cron)        | "scheduled lambda", "cron lambda"                 |
| Lambda + Exec Role | IAM Role → Lambda (minimal auto-exec-role)         | "create a lambda", "create a function"            |

### Components & technology rationale

| Component                | Choice                                                                | Why                                                                                                                                                                                                                        |
| :----------------------- | :-------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Orchestration**        | [`@langchain/langgraph`](https://langchain-ai.github.io/langgraphjs/) | Typed state machine; deterministic node routing; built-in HITL interrupts. Fits a graph that mixes LLM + deterministic + human steps.                                                                                      |
| **LLM (default)**        | `bedrock/amazon.nova-lite-v1:0`                                       | ~10× cheaper than GPT-4o for schema-shaped tasks; native CloudTrail audit via `bedrock:InvokeModel`.                                                                                                                       |
| **LLM gateway**          | [Vercel AI SDK](https://sdk.vercel.ai/)                               | Multi-provider (Bedrock / Anthropic / OpenAI / Google / Ollama) — operator can swap if Bedrock is unavailable in their region.                                                                                             |
| **Schema validation**    | Zod `.strict()` everywhere                                            | Hallucinated fields throw immediately; LLM self-corrects on the next turn. Same Zod types serve CLI prompts and MCP tool schemas.                                                                                          |
| **AWS plane**            | Cloud Control API + 5 MCP servers                                     | One CRUD interface for ~1000 CFN types; MCP servers for pricing / docs / IAM / WA-Security / billing. CFN schemas fetched directly via SDK (Epic 31).                                                                      |
| **Monorepo**             | Turborepo + pnpm workspaces                                           | `packages/core` is single-source for the graph and Zod schemas; CLI + MCP server import the same `createGraph()`.                                                                                                          |
| **Best-practice engine** | YAML rules + pure-function evaluator                                  | Each rule cites its source (FSBP, Well-Architected, AWS docs). Evaluation runs in <10 ms; new rule lands in ~45 minutes. Live count: see [`packages/best-practices/manifest.json`](packages/best-practices/manifest.json). |
| **Memory**               | JSON files in `~/.assignee/`                                          | `provisions.json` (managed-resource registry), `failures.json` (mistake log), `patterns.json` (learned patterns). Local-first; HMAC-chained audit log.                                                                     |
| **Terminal UX**          | `@clack/prompts` + `chalk` + `boxen`                                  | Idiomatic clack wizard for the elicitor; box-drawn plan output that pastes cleanly into chat tools.                                                                                                                        |

**Safety sandwich.** Six independent guardrails wrap every apply: Zod-strict schemas, prompt-injection guard (Bedrock Guardrails — deny topics `iam-privilege-escalation`, `credential-exfiltration`), pre-flight cost circuit breaker, IAM least-privilege role separation (`ASSIGNEE_OPERATOR_*` / `ASSIGNEE_READER_*` / `ASSIGNEE_AUDITOR_*`), state guard (read-before-write rejects stale plans), and the HITL gate.

**Repo layout (abbreviated):**

```
apps/cli            — Commander CLI; thin shim over @assignee/core
apps/mcp-server     — stdio MCP server; same createGraph() as the CLI
packages/core       — graph, nodes, ports, plugins, destroy strategies, pricing
packages/best-practices — YAML rule library + evaluation engine
```

For the full layout, see [docs/architecture.md](docs/architecture.md).

---

## 4. Business Model & Metrics

### Monetization — Open Core (Terraform / Pulumi / Infracost playbook)

| Tier                            | Audience                     | Includes                                                                                  |
| :------------------------------ | :--------------------------- | :---------------------------------------------------------------------------------------- |
| **Free CLI** _(MIT, this repo)_ | Solo operators / small teams | All resource types · compound patterns · best-practice library · JSON memory · MCP server |
| **Pro** _(future)_              | Power users                  | Unlimited plans · priority models · advanced patterns                                     |
| **Team** _(future SaaS)_        | Eng teams                    | Shared org policies · audit log · RBAC · drift dashboard                                  |
| **Enterprise** _(future SaaS)_  | Regulated buyers             | SSO/SAML · industry-aligned compliance posture · operational SLA · multi-cloud            |

The free CLI stays MIT-licensed forever. The paid tiers are a future direction, not a price list — concrete pricing is intentionally not committed at the course-submission stage. Distribution flywheel: free CLI adoption → MCP server distribution via Claude Code / Cursor / Windsurf → power users convert to paid → enterprise upsell on compliance and scale.

### KPIs (3 primary technical, 2 distribution)

|   #   | KPI                                                                                  | Target                                      | Current status                                                                                                                                                                  |
| :---: | :----------------------------------------------------------------------------------- | :------------------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **1** | Time-to-resource (single-resource happy path: bucket / queue / table)                | **≤ 5 min**                                 | ~4 min 12 s on `Create an S3 bucket` (S3 + IAM + Lambda paths benchmarked)                                                                                                      |
| **2** | Pre-flight cost-check pass rate (zero bill-shock incidents)                          | **100%**                                    | 100% — enforced by architecture; preflight blocks plans with no live price                                                                                                      |
| **3** | Best-practice violations caught before provisioning                                  | **≥ 80%** of detectable violations          | Bundled rule library covering FSBP + Well-Architected; <10 ms evaluation per plan. Live count: [`packages/best-practices/manifest.json`](packages/best-practices/manifest.json) |
| **4** | Plan acceptance rate (operator approves without `--set` overrides)                   | **≥ 90%**                                   | Design intent — measurement infrastructure deferred to Phase 2 (no telemetry hook captures `--set` overrides today)                                                             |
| **5** | Adoption (npm weekly downloads) — _post-publication distribution KPI (Phase 2 gate)_ | **≥ 1 000** within 90 days of public launch | Not yet published — Phase 2 target                                                                                                                                              |

**Engineering health (sanity floor, not a KPI):** vitest suite runs across all four workspace packages on every commit; CI green on Ubuntu, macOS, and Windows. Run `pnpm -r test:coverage` for the current case count and line coverage.

---

## 5. Roadmap

| Window             | Phase                                                       | Scope                                                                                                                                       |
| :----------------- | :---------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------ |
| Feb 2026           | **Phase 0 — POC** ✅                                        | CLI + LangGraph loop · Bedrock + Cloud Control · S3 / SSM / IAM Role                                                                        |
| Mar – Apr 2026     | **Phase 1 — CLI-first MVP** ✅                              | Sprints A–E · `list` / `destroy` / `status` / `drift` / `reconcile` · intelligence layer · MCP server · cross-platform CI                   |
| **May – Jul 2026** | **Phase 2 — Distribution** _(short-term, next 3 months)_    | npm + Homebrew packages · GitHub Action · MCP-server registries (Cursor / Claude Code) · "Show HN" launch · onboarding polish to hit KPI #5 |
| H2 2026 – H1 2027  | **Phase 3 — SaaS control plane** _(long-term, 6–12 months)_ | Auth · org-wide policy engine · audit log · SSO/SAML · drift dashboard · Team / Enterprise tier features                                    |
| 2027+              | **Phase 4 — Multi-cloud** _(post-traction)_                 | Provider abstraction (GCP / Azure) once SAM penetration validates the AWS-only thesis                                                       |

**Key scaling milestones (gates between phases):**

1. **1 000 npm weekly downloads** — validates the free-CLI distribution thesis (KPI #5); gates investment in paid tiers.
2. **First 10 conversions to a paid tier** — validates the conversion hypothesis on a pure-CLI surface.
3. **First team deployment with audit log + RBAC** — validates the SaaS control-plane premise; gates Phase 3 work.
4. **First regulated-buyer engagement** — validates the regulated-buyer hypothesis that justifies the local-first / no-SaaS-platform-fee posture.

---

## Install & quick start

This is the course-submission build — sources are MIT-licensed; nothing is published to npm yet.

```bash
# 1. Clone and build
git clone https://github.com/SergSlon/assignee-ai.git
cd assignee-ai && pnpm install && pnpm build

# 2. One-shot AWS bootstrap — creates the operator / reader / auditor IAM
#    users, attaches least-privilege policies, and writes a .env file. Needs
#    admin/root AWS creds (or a profile via --profile). Idempotent.
node apps/cli/dist/index.js setup

# 3. Sanity-check the local environment
node apps/cli/dist/index.js doctor --short

# 4. First plan — no AWS write happens until you confirm at the HITL gate
node apps/cli/dist/index.js plan "Create an S3 bucket named my-test-bucket"
```

For the full bootstrap walkthrough see [docs/how-to/quickstart.md](docs/how-to/quickstart.md) and [docs/aws-bootstrap.md](docs/aws-bootstrap.md). AWS SSO users: [docs/how-to/sso-authentication.md](docs/how-to/sso-authentication.md). MCP-server wire-up for Claude Code / Cursor / Windsurf: [docs/mcp-server.md](docs/mcp-server.md).

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
| Monorepo layout + 14-node graph + hexagonal ports                                      | [docs/architecture.md](docs/architecture.md)                                             |
| End-to-end flow diagrams (plan / apply / destroy / drift)                              | [docs/architecture-flows.md](docs/architecture-flows.md)                                 |
| How CLI, MCP server, and `@assignee/core` fit together                                 | [docs/integration-architecture.md](docs/integration-architecture.md)                     |
| What the AI parts actually do (LLM callsites, MCP servers, BP engine, HITL)            | [docs/explanation/ai-architecture.md](docs/explanation/ai-architecture.md)               |
| Load-bearing invariants (partition-aware ARN, CCAPI NotFound, IAM safety allowlist, …) | [docs/explanation/invariants.md](docs/explanation/invariants.md)                         |
| Contributing a new BP rule (worked example)                                            | [docs/explanation/contributing-a-bp-rule.md](docs/explanation/contributing-a-bp-rule.md) |
| Testing strategy + how to run the suites                                               | [docs/testing-guide.md](docs/testing-guide.md)                                           |
| Audit log HMAC chain (verify, key rotation)                                            | [docs/how-to/audit-trail.md](docs/how-to/audit-trail.md)                                 |
| Operator runbook (incident response patterns)                                          | [docs/runbooks/incident-response.md](docs/runbooks/incident-response.md)                 |

---

## License · Contributing · Security

- **License:** MIT — see [LICENSE](LICENSE).
- **Changelog:** see [CHANGELOG.md](CHANGELOG.md).
- **Contributing:** see [CONTRIBUTING.md](CONTRIBUTING.md) for the dev loop and pre-commit gates.
- **Security:** see [SECURITY.md](SECURITY.md) for vulnerability reporting.
