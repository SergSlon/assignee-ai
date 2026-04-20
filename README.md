# Assignee.ai

[![CI](https://github.com/SergSlon/assignee-ai/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/SergSlon/assignee-ai/actions/workflows/ci.yml)
[![Cross-platform](https://github.com/SergSlon/assignee-ai/actions/workflows/ci-cross-platform.yml/badge.svg?branch=main)](https://github.com/SergSlon/assignee-ai/actions/workflows/ci-cross-platform.yml)
[![Coverage](https://img.shields.io/endpoint?url=https://gist.githubusercontent.com/SergSlon/f9d960dd5a1defd7b8fbd4656df40915/raw/assignee-ai-coverage.json)](https://github.com/SergSlon/assignee-ai/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20.11-brightgreen?logo=node.js)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript)](packages/typescript-config/strict.json)
[![pnpm](https://img.shields.io/badge/pnpm-workspaces-f69220?logo=pnpm)](pnpm-workspace.yaml)

> Type AWS infrastructure intent in English. Get a real, tagged, cost-estimated AWS resource — no IaC code, no state file, no CDK bootstrap, no Terraform backend. Human approval before every apply.

## 30-second hero

<!-- Real captured transcript — run on 2026-04-20 against a fresh `main` build:
     `node apps/cli/dist/index.js plan --no-apply "Create an S3 bucket named hero-demo-bucket"`.
     The plan box is rendered by `renderPlanBox` in
     `packages/core/src/utils/display-plan.ts` (the apps/cli path is a thin
     re-export shim). TTY output wraps the content in a boxen frame; the
     non-TTY form below uses a plain `=== Plan ===` title for readability in
     markdown. Advice and findings lists are truncated with `... N more` —
     everything shown is verbatim from the real run (run-id fa465600af5a). -->

```console
$ assignee plan "Create an S3 bucket named hero-demo-bucket"
assignee plan  [region=us-east-1  account=054125018476]
✦ Assignee.ai — AI-Native Cloud Operator
Connecting to AWS (3 services)...
Loading tools...
Generating plan...

=== Plan ===
Resource Type:   AWS::S3::Bucket
Region:          us-east-1 (cross-regional inference: us.*)
Config:
  Bucket Name           hero-demo-bucket
  Block Public Access   BlockPublicAcls: Yes, BlockPublicPolicy: Yes,
                        IgnorePublicAcls: Yes, RestrictPublicBuckets: Yes
  Encryption            AES-256 (SSE-S3) enabled
  Versioning            Status: Enabled
Estimated Cost:  $0.0230/GB-month (live)

  Usage-based (per-unit rates):
  · Storage                  $0.0230/GB-mo
  · PUT requests             $0.0050/1000 reqs
  · GET requests             $0.0004/1000 reqs
  · Data transfer out        $0.0900/GB
  Prices fetched at 2026-04-20

Advice:          * 🔒 Public access fully blocked — bucket is protected from
                   accidental public exposure
                 * 💰 Consider adding lifecycle rules to transition infrequent
                   data to S3-IA or Glacier after 30-90 days
                 * (... 3 more hints — SSE-KMS, Block Public Access, lifecycle
                   tiering)

Findings:        5 high, 5 medium (4 fixable)
  [HIGH]   S3 bucket should disable ACLs (BucketOwnerEnforced)
           → Fix: --set OwnershipControls=BucketOwnerEnforced
  [HIGH]   S3 bucket should enforce SSL-only requests
           → Manual: Add bucket policy to deny non-HTTPS requests
  (... 8 more findings — event notifications, lifecycle config, access
   logging, object lock, cross-region replication, intelligent tiering,
   multipart-upload abort, SSE-KMS for compliance)
  💡 4 findings can be auto-fixed. Run `assignee init` to enable.

Apply now? (AWS::S3::Bucket, est. $0.0230/GB-month) ▸
```

> **Hero status:** real captured output (run 2026-04-20 against HEAD). Tags and provision tail are not shown — the plan above is pre-apply; the apply step would inject `managed-by=assignee`, `assignee-run-id=<uuid>`, `environment=poc` onto the CloudControl `Tags` array (see `packages/core/src/utils/tags.ts`). An asciinema cast that includes the apply phase lands at `docs/_assets/hero.cast` in v0.2.

## Install

```bash
# v0.2 (npm publish target):
#   npm install -g assignee
#
# Today (source build, MIT-licensed):
git clone https://github.com/assignee-ai/assignee.ai.git
cd assignee.ai && pnpm install && pnpm build
pnpm link --global        # adds 'assignee' to PATH
assignee doctor --short   # verify AWS credentials + Bedrock region
```

See [docs/aws-bootstrap.md](docs/aws-bootstrap.md) for the IAM policy setup (operator / reader / auditor).

## Table of contents

- [30-second hero](#30-second-hero)
- [Install](#install)
- [What this is](#what-this-is)
- [What this is NOT](#what-this-is-not)
- [Who this is for — "Mara, the solo / small-team AWS operator"](#who-this-is-for--mara-the-solo--small-team-aws-operator)
- [How it works](#how-it-works)
- [Commands](#commands)
- [vs the competition](#vs-the-competition)
- [Supported resource types](#supported-resource-types)
- [MCP Server](#mcp-server)
- [Architecture](#architecture)
- [Development](#development)
- [Project status](#project-status)
- [AWS setup](#aws-setup)
- [Documentation](#documentation)
- [License · Contributing · Security](#license--contributing--security)

## What this is

- **Plain English in. Real AWS resource out.** CloudControl API + auto-tagging. No generated HCL, TypeScript, or Pulumi to maintain.
- **No state file, no Pulumi stack, no Terraform backend, no CDK bootstrap.** Desired state is the AWS account itself, read back on every plan.
- **Human approval gate (HITL) on every plan**; 185 best-practice rules with auto-fix; cost preflight via AWS Pricing MCP; reversible destroy with confirmation.

> **Shape the rules.** Assignee's best-practice library is the community moat — every rule is YAML, every rule cites its source (FSBP control IDs, AWS Well-Architected pillars, AWS docs URLs, Trusted Advisor checks), and a new rule lands in ~45 minutes of focused work. See [docs/explanation/contributing-a-bp-rule.md](docs/explanation/contributing-a-bp-rule.md) for a worked example.

## What this is NOT

- **Not multi-cloud.** AWS-only by design (Epic 13 deferred; see [project status](#project-status)).
- **Not a Terraform replacement for platform teams.** If you already run Terraform with Spacelift/env0/HCP and want an AI layer, use their native MCP/NL tooling — Assignee is for the operator who does not want to own Terraform state at all.
- **Not a Kubernetes operator.** See [kagent](../wiki/competitors/kagent.md) for K8s day-2 ops.
- **Not for HCL-fluent platform engineers** who already love Cursor + the Terraform MCP.

## Who this is for — "Mara, the solo / small-team AWS operator"

Mara has 2–8 years of experience, writes Python and TypeScript at an intermediate level, and does NOT write HCL or Pulumi day-to-day. She runs a side project or a small production account (1–10 engineers, under $10k/mo AWS bill). She tried Terraform once and got stuck on state backends; tried CDK and got stuck on bootstrap; now she clicks in the AWS Console every six months and regrets it. She uses Claude Code or Cursor, respects "local-first, my credentials never leave the box," and wants to provision a VPC in a terminal without owning a state file.

If that is you, Assignee.ai is for you. If you are a platform engineer at a 500+ engineer company, it is not — use Pulumi / Terraform / Crossplane.

When Mara works alone, she runs `assignee plan` and `assignee apply` in her terminal. When her teammate Dev wants to drive the same provisioning from Claude Code, Cursor, or Windsurf, the same primitives flow through the [MCP Server](#mcp-server) — `plan_resource`, `apply_plan`, `destroy_resource`, `list_managed_resources`, `estimate_cost`. Same graph, same BP rules, same HITL approval; just a different entry-point. CLI and MCP are one product with two surfaces, so an intent that worked in the terminal works inside an agent harness without a second mental model.

---

## How it works

1. **Plan** — Describe your intent in plain English. The LLM parses the intent, fetches the CloudFormation schema, and elicits resource options through an interactive wizard. It then generates a validated `desiredState` JSON, evaluates best-practice rules, and produces a cost estimate.
2. **Approve** — review the plan in the terminal and confirm (HITL).
3. **Apply** — Cloud Control API (or SDK fallback) provisions the resource; tags are injected, State Guard prevents stale-plan overwrites, status is polled until terminal state, and results are written to memory.

```
intent_parser → schema_fetcher → option_elicitor → compound_dispatcher
  → plan_generator → advice_generator → bp_evaluator → fix_applicator
    → preflight_guard → human_approval ─[HITL]─ → resource_provisioner
      → status_poller → result_formatter
```

| Node                   | What it does                                                                                                                                                               |
| :--------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `intent_parser`        | Classifies natural language into a resource type + action. Compound keywords ("create a vpc") are matched at zero LLM latency                                              |
| `schema_fetcher`       | Fetches the CloudFormation schema for the target type via `@aws-sdk/client-cloudformation`                                                                                 |
| `option_elicitor`      | Interactive wizard — prompts for required and optional fields with live pricing, smart defaults, and `showIf` conditionals                                                 |
| `compound_dispatcher`  | Expands a compound pattern (e.g. VPC) into a dependency-ordered resource queue with marker-ref cross-references                                                            |
| `plan_generator`       | LLM (Bedrock) produces a `desiredState` JSON from the schema + user answers. Validates output with Zod                                                                     |
| `advice_generator`     | LLM-produced non-blocking advisory notes on the plan (cost shape, likely gotchas) surfaced alongside the plan box for operator context                                     |
| `bp_evaluator`         | Evaluates 185 best-practice rules against the plan (count matches `packages/best-practices/manifest.json`). Flags violations by severity (CRITICAL / HIGH / MEDIUM / INFO) |
| `fix_applicator`       | Auto-patches fixable violations (e.g. enables S3 encryption). Shows "Changed X → Y because BP-### (auto-fixed)" per fix                                                    |
| `preflight_guard`      | Blocks the plan if any CRITICAL / blocking findings remain unfixed. Runs placeholder-ARN rejection + cost preflight                                                        |
| `human_approval`       | Renders the plan box and waits for explicit user confirmation before any AWS resource is created (HITL gate)                                                               |
| `resource_provisioner` | State Guard (read-before-write) then CloudControl API `createResource`. Tags injected automatically                                                                        |
| `status_poller`        | Polls CloudControl until terminal state (SUCCESS / FAILED). Extended timeouts for RDS, ELBv2, NAT Gateway                                                                  |
| `result_formatter`     | Renders success/failure output, writes provision records to memory, runs post-provision security checks                                                                    |

13 nodes. Compound patterns loop `plan_generator → result_formatter` per resource in dependency order. Source of truth: `packages/core/src/graph/create-graph.ts` (`.addNode` calls) and the node implementations under `packages/core/src/graph/nodes/`. `apps/cli/src/nodes/advice/cost-optimizer/` and `apps/cli/src/nodes/fix-applicator/orchestrator.ts` are thin re-export shims from `@assignee/core`; the rest of the `apps/cli/src/nodes/` tree is CLI-only test code.

All AWS credentials stay local — they never leave your machine. Bedrock calls run against your own account.

---

## Commands

13 top-level commands. Run `assignee <command> --help` for the full flag surface. See [docs/commands.md](docs/commands.md) for the full reference.

| Command                        | Description                                                   | Key flags                                                         |
| :----------------------------- | :------------------------------------------------------------ | :---------------------------------------------------------------- |
| `assignee plan <intent>`       | Generate infrastructure plan (no AWS writes)                  | `--source`, `-o json\|text`, `--no-apply`, `--no-advice`, `--set` |
| `assignee apply <intent>`      | Plan + provision with HITL approval                           | `--source`, `--yes`, `--wizard`, `--checkpoint`, `--set`          |
| `assignee init`                | Initialize `.assignee/` project directory                     | `--global`                                                        |
| `assignee list`                | Show managed resources with cost                              | `--region`, `--json`                                              |
| `assignee destroy <resource>`  | Safe single-resource teardown with confirmation               | `--yes`                                                           |
| `assignee drift [resource-id]` | Check resources for configuration drift                       | `--resource`, `--region`, `--status`, `--json`, `--concurrency`   |
| `assignee reconcile`           | Reconcile drifted resources to desired state                  | `--resource`, `--dry-run`, `--auto-reconcile`                     |
| `assignee status`              | Intelligence summary (memory, findings, costs)                | `--json`, `--region`, `--bp-coverage`                             |
| `assignee setup`               | Automate IAM role/policy creation                             | `--profile`, `--yes`                                              |
| `assignee completions <shell>` | Generate shell completions (bash/zsh/fish)                    | —                                                                 |
| `assignee optimize`            | Cost-optimization recommendations per resource                | `--resource`, `--region`, `--json`, `--apply`                     |
| `assignee doctor`              | Diagnose local environment (Node, creds, MCP) + identity info | `--json`, `--fix`, `--short`                                      |
| `assignee version`             | Print version + Node/platform + MCP server pins               | —                                                                 |

Discovery shortcuts live under `plan --help`: supported resource types, compound patterns, and example intents. `doctor --short` replaces the removed `whoami` subcommand and prints the active IAM identity + region.

---

## vs the competition

| Axis                    | Assignee                | kagent                     | Pulumi Neo                                                            | Terraform + Claude/Cursor     | CDK + Amazon Q           | Crossplane                  | HCP Terraform AI          |
| ----------------------- | ----------------------- | -------------------------- | --------------------------------------------------------------------- | ----------------------------- | ------------------------ | --------------------------- | ------------------------- |
| Code artifact           | **None**                | K8s CRDs                   | Pulumi code + state                                                   | HCL + state                   | CDK code + bootstrap     | K8s CRDs (Compositions)     | HCL + state (HCP-managed) |
| Primary scope           | AWS greenfield, ops     | K8s day-2 ops              | Any cloud (stack)                                                     | Any cloud (HCL-fluent)        | AWS (CDK)                | Any cloud (via K8s cluster) | Any cloud (HCL-fluent)    |
| BP rules on free path   | **185, YAML**           | N/A _(ops tool)_           | CrossGuard _(local free; 0 bundled rules; paid SKU for policy packs)_ | Sentinel _(paid)_             | cdk-nag _(add-on, free)_ | None bundled                | Sentinel _(paid)_         |
| Plan preview            | NL → plan-box + HITL    | N/A _(not provisioning)_   | `pulumi preview`                                                      | `terraform plan`              | `cdk diff`               | `kubectl diff` on CR        | `terraform plan` (web UI) |
| Onboarding prerequisite | None (Node + AWS creds) | K8s cluster + Helm         | Pulumi CLI + state backend                                            | Terraform CLI + state backend | Node + cdk bootstrap     | K8s cluster + CRDs          | HCP account               |
| Cloud coverage          | AWS-only                | K8s (any cloud underneath) | Multi-cloud                                                           | Multi-cloud                   | AWS-only                 | Multi-cloud                 | Multi-cloud               |
| Runtime dependency      | Node + AWS creds        | K8s cluster + Helm         | Pulumi CLI + cloud account                                            | Terraform CLI + state BE      | Node + CDK bootstrap     | K8s cluster + providers     | HCP account (hosted)      |

**Footnote on omitted categories.** Three hosted / enterprise-tier adjacents are not in the scorecard because they target different buyers: **Spacelift Intent** (hosted Terraform runner with AI-assisted review — enterprise platform-team buyer, priced per run), **env0** (hosted Terraform/OpenTofu collaboration platform — enterprise team buyer, priced per user), and generic hosted-HCP AI features beyond the HCP Terraform AI column above. If you are an enterprise platform team already paying for one of these, Assignee is not a replacement — it is a different modality for a different operator profile.

**Where Assignee loses.** The `Cloud coverage` row is the honest trade-off: four of the six alternatives are multi-cloud by design. Assignee is AWS-only (Epic 13, provider-abstraction, is deferred). If your workload spans AWS + GCP or AWS + Azure, pick Terraform, Pulumi, or Crossplane.

> Reads top-down: the upper rows (code artifact, BP rules on free path) identify hard requirements — if "no code file to maintain" and "rules on the free path" are non-negotiable, Assignee is the only column that satisfies both. The lower rows (cloud coverage, runtime dependency) are the honest trade-offs — AWS-only, CLI on your own box. Pick the column whose row-by-row fit matches your constraints, not whichever shouts loudest.

Nine direct / adjacent competitors — eight archived in the [workspace wiki](../wiki/competitors/) plus Crossplane (external link):

- **vs [kagent](../wiki/competitors/kagent.md)** — kagent runs day-2 operations and observability INSIDE a Kubernetes cluster (Helm-installed controller, kubectl/helm/istioctl/prometheus-query tools). It diagnoses and reconciles existing workloads; it is not an IaC provisioner. Assignee provisions AWS primitives FROM zero, no cluster required. Pick kagent for K8s reconciliation; pick Assignee for greenfield AWS.
- **vs [Pulumi AI / Neo](../wiki/competitors/pulumi-ai.md)** — Pulumi Neo writes Pulumi code in your language of choice; you still maintain a stack and a state file (local or Pulumi Cloud). Neo ships in the Team tier ($40/mo per seat at time of writing); CrossGuard policy-as-code is a separate SKU. Assignee writes nothing — resources live in your AWS account, tagged, with no source file to keep in sync, and all 185 BP rules ship on the free path.
- **vs [Terraform + Claude/Cursor](../wiki/competitors/claude-writes-terraform.md)** — for the HCL-fluent engineer who already loves the Terraform MCP + Cursor, that combo is excellent and Assignee does not compete. Assignee targets the engineer who does not want to own HCL.
- **vs [Terraform AI (HCP + AI)](../wiki/competitors/terraform-ai.md)** — HCP Terraform's AI features (Copilot, plan explain) still produce HCL and a state file on the backend. Sentinel policy is a paid tier. Assignee bundles 185 BP rules on the free path.
- **vs [CDK + Amazon Q](../wiki/competitors/cdk-ai.md)** — Q Developer's Console-to-Code generates CDK; you still do `cdk bootstrap` and `cdk deploy` and maintain TypeScript or Python. cdk-nag (an open-source AWS-maintained add-on) brings rulesets (AWS Solutions, HIPAA, NIST, PCI) but must be wired in separately and operates on synthesized templates, not on an intent. Different modality.
- **vs [Crossplane](https://www.crossplane.io/)** — Crossplane is a Kubernetes control plane: you run a cluster, install provider CRDs (AWS, GCP, Azure), and author Compositions / Claims in YAML. Excellent for platform teams who already run K8s and want a control-loop for infrastructure. Assignee requires no cluster and targets operators who do not want one.
- **vs [SST Ion](../wiki/competitors/sst.md)** — SST is TypeScript infrastructure-as-code for serverless app developers. Assignee is intent-as-infrastructure for operators — different category, different audience.
- **vs [Nitric](../wiki/competitors/nitric.md)** — Nitric is code-defines-infra (TypeScript/Python), multi-cloud target. Assignee is English-defines-provisioning, AWS-only, with no code artifact.
- **vs [Wing](../wiki/competitors/wing.md)** — Wing (shut down April 9, 2025) was a new IaC language. Included here for completeness; no current comparison.

Short answer: if you want a file to commit, pick any of the above. If you want a running AWS resource and a memory record, pick Assignee.

Assignee's CLI stays free (MIT) forever; the future SaaS tier (no commitment date) is reserved for multi-user / RBAC / audit-trail features and will sit between free-OSS and Terraform per-resource tier pricing. See [docs/explanation/oss-vs-saas.md](docs/explanation/oss-vs-saas.md).

### Disruption risk — three credible 12-18 month scenarios

No single-axis moat survives a 12-18 month vendor response. Three scenarios have comparable credibility; the bundle (not any one pillar) is the durable claim.

| Scenario                                                                                                                     | Probability (12-18mo) | Impact on Assignee                              | Defensibility                                                                                                                |
| ---------------------------------------------------------------------------------------------------------------------------- | --------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **HCP Terraform / IBM** ships native pre-apply cost preflight (gate, not PR-comment — Infracost-class, post-IBM acquisition) | HIGH                  | MED (cost-gate axis collapses; bundle survives) | MED — deterministic cost preflight against live AWS Pricing MCP, no SaaS platform fee, plan-time not PR-time                 |
| **Amazon Q + CCAPI** direct-provision mode (no CDK intermediate; free, AWS-native, every account)                            | MED                   | HIGH (distribution moat)                        | HIGH risk — BP community on-ramp, local-first MIT, non-AWS LLM optionality (Anthropic / OpenAI / Google / Ollama)            |
| **Spacelift Intent (OSS April 2026) + env0** ship no-HCL NL→provision with OPA/Sentinel gates                                | MED                   | MED (mid-market 10-50 eng teams)                | MED — HITL gate routed through the identical graph regardless of surface; local-first + no-SaaS posture for regulated buyers |

Defensive response — already in flight across all three:

- **Best-practice library as community on-ramp.** Every BP rule is YAML; a new rule lands in ~45 minutes. The moat is not "we have 185 rules" (a snapshot); it is "a new rule lands in 45 minutes by a community contributor." See [docs/explanation/contributing-a-bp-rule.md](docs/explanation/contributing-a-bp-rule.md).
- **Local-first, open-source, MIT.** Credentials never leave the operator's machine; the full graph, rules, and prompts are inspectable. A first-party offering has to keep pace on transparency to displace a local-first OSS tool with its rule library held in a public repo.
- **Non-AWS LLM optionality.** The Vercel AI SDK lets Mara swap to Anthropic / OpenAI / Google / Ollama — Assignee is not locked to Bedrock, so an operator wary of single-vendor AI has a credible escape hatch. (Implementation: [`packages/core/src/llm/client-factory.ts`](packages/core/src/llm/client-factory.ts) lazy-loads each provider via the Vercel AI SDK so unused SDKs never enter the bundle.)

These are live risks, not moat claims. They are listed here so the reader can price them in.

#### Bundle durability — 12-month threat vs. defensibility

The single-axis moats each have a shelf life. The compound bundle is the durable claim: a competitor who adds cost preflight still lacks BP auto-fix; a competitor who adds BP auto-fix still lacks plan-time cost preflight; a competitor who adds both is Pulumi Neo at $40/mo, not a free CLI.

| Differentiator                                        | 12-month threat                                                    | Defensibility | 2026 response                                                           |
| ----------------------------------------------------- | ------------------------------------------------------------------ | ------------- | ----------------------------------------------------------------------- |
| **Pre-apply BP auto-fix** (185 YAML rules, free path) | MED — cdk-nag + CrossGuard engines exist; bundled rules are DIY    | HIGH          | Community contribution flow; source-cited YAML rules                    |
| **Plan-time cost preflight** (live AWS Pricing MCP)   | HIGH — HCP/IBM or Infracost-native-gate likely 6-12mo              | MED           | Deterministic gate, no SaaS platform fee, local-first, not a PR-comment |
| **Local-first, no state file**                        | LOW — SaaS platforms cannot easily retrofit no-backend posture     | HIGH          | Regulated-buyer posture; credentials never leave the box                |
| **HITL gate before every apply**                      | MED — agents-generate-then-agents-apply pipelines will proliferate | HIGH          | Single graph, single gate, enforced at CLI and MCP surface alike        |
| **MCP parity via shared `createGraph`**               | HIGH — every IaC tool will expose an MCP within 12mo               | MED           | Bundle parity, not MCP novelty: the agent cannot bypass the safety loop |

---

## Supported resource types

**37 first-class types** — curated coverage of the AWS core that 80% of small-team workloads need: S3, IAM, Lambda, RDS, EC2, VPC, DynamoDB, SQS, SNS, ELBv2, ECS, ECR, API Gateway v2, EventBridge, KMS, CloudFront, Secrets Manager, SSM, CloudWatch, plus 18 more. Every type flows through CloudControl API — zero direct SDK write paths. Run `assignee plan --help` for the live listing with field counts and BP rule coverage, or see [docs/resource-types.md](docs/resource-types.md) for the full reference.

### Compound architecture patterns

Multi-resource intents are detected by keyword matching (zero LLM latency) and provisioned in dependency order. Run `assignee plan --help` for the live listing.

| Pattern              | Resources                                                     | Trigger keywords                                                |
| :------------------- | :------------------------------------------------------------ | :-------------------------------------------------------------- |
| VPC Networking       | VPC → Subnets → IGW → RouteTables → NAT (17 resources)        | "create a vpc", "vpc with subnets"                              |
| Serverless API       | IAM Role → Lambda → API Gateway V2 (8 resources)              | "serverless api", "lambda api"                                  |
| Static Website       | S3 Bucket + CloudFront + OAC + S3 upload                      | "static website", "static site"                                 |
| Message Processing   | SQS DLQ → SQS + DynamoDB + IAM Role → Lambda                  | "message queue", "event processing"                             |
| Three-Tier Web       | VPC → Subnet → SecurityGroup → ECS → ALB                      | "three tier", "web application"                                 |
| Container Service    | ECR → ECS Cluster → IAM Role                                  | "container service", "ecs"                                      |
| EFS with private VPC | VPC + private subnets + NFS SG + FS + MountTargets            | "create an efs", "shared file system"                           |
| Scheduled Lambda     | IAM Role → Lambda → EventBridge Rule (cron)                   | "scheduled lambda", "cron lambda"                               |
| Lambda + Exec Role   | IAM Role → Lambda (minimal auto-exec-role pattern)            | "create a lambda", "create a function"                          |
| VPC Public-Only      | VPC + public Subnets + IGW + Routes (free-tier, 11 resources) | "vpc public only", "cheap vpc", "simple vpc", "vpc without nat" |

---

## MCP Server

**MCP is not the moat — every IaC tool will have one within 12 months. The moat is that the MCP path routes through the identical 13-node graph, 185 BP rules, and HITL gate as the CLI, so an agent cannot silently bypass the approval loop the way an agent-generates-HCL-then-agent-applies-HCL pipeline can.**

The `@assignee/mcp-server` package exposes Assignee.ai as an MCP server for AI coding agents (Claude Code, Cursor, Windsurf). It runs over **stdio transport, spawn-per-session** — the harness launches `assignee-mcp-server` as a child process on demand, no daemon required, credentials and state stay on the operator's box.

Five tools are registered (see `apps/mcp-server/src/tools/index.ts`):

- `plan_resource` — runs the 13-node graph up to the HITL gate and returns the plan box without provisioning
- `apply_plan` — executes an approved plan through `resource_provisioner` → `status_poller`
- `destroy_resource` — safe single-resource teardown using the per-type strategies under `packages/core/src/destroy-strategies/`
- `list_managed_resources` — enumerates resources tagged with `assignee:managed=true` via the Resource Groups Tagging API, with the IAM-roles parallel listing path added in Story 52-2 (RGTA does not return IAM roles)
- `estimate_cost` — pricing lookup against the `awslabs.aws-pricing-mcp-server` for a desired-state JSON

The CLI is one-shot per intent; the MCP server is a long-lived child the agent can call repeatedly within a session. Both surfaces import `createGraph` from `@assignee/core`, so the graph, BP rules, HITL gate, and credential separation are identical — an agent calling `apply_plan` hits the same approval boundary as a human typing `assignee apply`.

Wire-up snippets for each harness live under [`apps/mcp-server/examples/`](apps/mcp-server/examples/) (`claude-code-mcp-config.json`, `cursor-mcp.json`, `windsurf-mcp-config.json`). See [docs/mcp-server.md](docs/mcp-server.md) and [apps/mcp-server/README.md](apps/mcp-server/README.md) for setup, env-var requirements, and troubleshooting.

---

## Architecture

```
apps/
  cli/
    src/
      commands/        plan.ts · apply.ts · init.ts · list.ts · destroy.ts
                       status.ts · completions.ts · doctor.ts · drift.ts
                       reconcile.ts · optimize.ts · setup.ts
      nodes/           re-export shims that forward to @assignee/core/graph/nodes
      services/        graph.ts + graph-state.ts + graph-routing.ts (re-export
                       shims) · mcp-client.ts · memory.ts · list-resources.ts
                       resource-resolver.ts · billing.ts · status-aggregator.ts
                       llm-adapter.ts
      config/          mcp-servers.ts
      utils/           display.ts · logger.ts · tags.ts · mcp.ts · pricing-lookup.ts
    scripts/           capture → process → build fixture pipeline
  mcp-server/
    src/               MCP server entry point, tool handlers; imports
                       createGraph directly from @assignee/core/graph
packages/
  core/
    src/
      graph/           create-graph.ts (LangGraph builder) · graph-state.ts
                       (Zod Annotation) · graph-routing.ts (conditional edges)
        nodes/         intent-parser · schema-fetcher · option-elicitor
                       compound-dispatcher · plan-generator · bp-evaluator
                       fix-applicator · preflight-guard · human-approval
                       resource-provisioner · status-poller · result-formatter
                       advice-generator
      ports/           hexagonal-architecture boundaries — nodes depend on
                       these interfaces, concrete provider factories live
                       behind them so adapters (Bedrock/mock LLM, CloudControl
                       SDK) can be swapped without touching graph code:
                       · llm-port.ts (LlmPort + LlmCallOptions with callsite
                         token attribution)
                       · provisioning-port.ts (ProvisioningPort with typed
                         ProvisioningErrorKind discriminated union)
      destroy-strategies/ registry + per-type strategies (CloudFront, EIP,
                       ELBv2, EFS, IGW, RouteTable, S3, DynamoDB, …)
      types/           result.ts (Result<T,E> monad)
      config/          resource-types.ts · resource-identifiers.ts
                       resource-policy.ts · iam-policies/
      resource-plugins/  types.ts · registry.ts · index.ts
                         plugins/  s3-bucket · ec2-instance · rds-dbinstance
                                   lambda-function · generic
      pattern-templates/ registry.ts · types.ts
                         patterns/ serverless-api · static-website · message-processing
                                   three-tier-web · container-service · vpc-networking
      pricing/         pricing data and lookup
      guardrails/      built-in guardrail rules
      errors.ts
      test-fixtures/   mcp-mock-responses/ (real MCP captures, per-resource)
  best-practices/
    src/               BP YAML schema, trigger engine, rule library
```

**Implementation stack** (choices, not moat claims — every one is swappable):

- [`@langchain/langgraph`](https://langchain-ai.github.io/langgraphjs/) — agentic workflow orchestration for the 13-node pipeline
- [`ai`](https://sdk.vercel.ai/) + [`@ai-sdk/amazon-bedrock`](https://sdk.vercel.ai/providers/ai-sdk-providers/amazon-bedrock) — Vercel AI SDK with multi-provider support (Bedrock, Anthropic, OpenAI, Google, Ollama)
- [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/sdk) + [`@langchain/mcp-adapters`](https://github.com/langchain-ai/langchainjs/tree/main/libs/langchain-mcp-adapters) — MCP server integration
- [`@clack/prompts`](https://github.com/bombshell-dev/clack) + `chalk` + `boxen` — terminal UX

**MCP servers (spawned at runtime via `uvx`):**

| Server                                         | Purpose                          | Tier     |
| :--------------------------------------------- | :------------------------------- | :------- |
| `awslabs.aws-pricing-mcp-server`               | Live cost estimates              | Core     |
| `awslabs.aws-documentation-mcp-server`         | AWS doc search and reads         | Core     |
| `awslabs.iam-mcp-server`                       | IAM policy analysis (read-only)  | Optional |
| `awslabs.well-architected-security-mcp-server` | Well-Architected security pillar | Optional |
| `awslabs.billing-cost-management-mcp-server`   | Billing and cost management      | Optional |

Optional servers are spawned only when the corresponding command requires them.

> **Note:** CloudFormation schemas and CCAPI provisioning are accessed directly via `@aws-sdk/client-cloudformation` and `@aws-sdk/client-cloudcontrol`. A guardrail test in `packages/core/src/config/mcp-servers.test.ts` enforces that the legacy `cfn-mcp-server`, `ccapi-mcp-server`, and `aws-iac-mcp-server` wrappers cannot re-appear.

**LLM provider:** Default `us.amazon.nova-lite-v1:0` (Bedrock). Override with `ASSIGNEE_LLM_DEFAULT=anthropic/claude-haiku-4-5` or any `provider/model-id` string.

**Credential separation:**

- `ASSIGNEE_OPERATOR_*` env vars → operator IAM user → Bedrock AI calls + CloudFormation provisioning
- `ASSIGNEE_READER_*` env vars → reader IAM user → MCP servers with read-only access (CCAPI, pricing)
- `ASSIGNEE_AUDITOR_*` env vars → auditor IAM user → MCP servers with audit access (CloudFormation describe/list)

**Advanced overrides:**

- `ASSIGNEE_NO_CLARIFIER=1` — skip the intent-clarifier prompt on ambiguous inputs (useful in CI / scripted flows where no operator is available to answer). Source: [`apps/cli/src/services/clarifier.ts`](apps/cli/src/services/clarifier.ts).
- `ASSIGNEE_MCP_MAX_ACTIVE_APPLIES=N` — override the default 100 concurrent-apply ceiling on the MCP server (tune for high-concurrency CI fleets; must be a positive integer — invalid values fall back to 100). Source: [`apps/mcp-server/src/tools/apply-plan/active-applies.ts`](apps/mcp-server/src/tools/apply-plan/active-applies.ts).
- `--resource-type` shorthand warnings — shorthand aliases (`s3`, `lambda`, `rds`, etc.) resolve to a single "headline" CFN type; when the underlying service also exposes other supported types, the CLI emits a `console.warn` on stderr suggesting the explicit CFN form. Source: [`apps/cli/src/commands/resource-type-filter.ts`](apps/cli/src/commands/resource-type-filter.ts).

---

## Development

```bash
pnpm build         # compile all packages (CLI, MCP server, core, best-practices)
pnpm test          # full unit suite across 4 packages
pnpm check-types   # TypeScript type check
```

Pre-commit hook runs: prettier → check-types → test.

### Test fixtures

All MCP mock responses in `packages/core/src/test-fixtures/mcp-mock-responses/` are captured from live MCP servers (not fabricated). Captured responses are tracked in git. To refresh:

```bash
cd apps/cli/scripts
node capture-mcp-responses.mjs    # requires .env with ASSIGNEE_READER_* and ASSIGNEE_AUDITOR_* credentials
node process-captured-responses.mjs
```

---

## Project status

**Status: pre-public.** Source available under MIT (see [LICENSE](LICENSE)). `npm publish` is deferred until v0.2 — see [CHANGELOG.md](CHANGELOG.md). To track release, watch the repo.

Packages `@assignee/cli` and `@assignee/mcp-server` are `"private": true` and installable only from source today. Public CI status, npm registry links, and release badges are intentionally omitted until first release; the coverage badge above is rendered from a secret gist (`f9d960dd5a1defd7b8fbd4656df40915`) updated by `ci-core.yml` on every green `main` push via `schneegans/dynamic-badges-action` — internal visibility only, not a published artifact.

### Completed epics

| Epic   | Description                                                                                                                                | Status                     |
| :----- | :----------------------------------------------------------------------------------------------------------------------------------------- | :------------------------- |
| **0**  | Project Foundation & Monorepo Setup                                                                                                        | Done                       |
| **1**  | Plan Command (LangGraph, MCP, intent parsing, plan generation)                                                                             | Done                       |
| **2**  | Apply Command (HITL, provisioning, status polling, tagging)                                                                                | Done                       |
| **7**  | Resource Intelligence (option elicitation, pricing, doc hints — see [Supported resource types](#supported-resource-types))                 | Done                       |
| **8**  | Compound Provisioning (architecture patterns, dependency ordering — see [Compound architecture patterns](#compound-architecture-patterns)) | Done                       |
| **9**  | Architecture Hardening (type safety, error handling, prompt injection guard)                                                               | Done                       |
| **10** | Plan Intelligence & Checkpoint (save/resume, guardrails, plan-to-apply)                                                                    | Done                       |
| **11** | Expert Apply Mode (`--yes`, `--no-wizard`, `--checkpoint`)                                                                                 | Done                       |
| **12** | Best Practices Library (YAML schema, trigger engine, 185 rules today, FSBP)                                                                | Done (12.4, 12.6 deferred) |
| **14** | Multi-Provider LLM Gateway (Vercel AI SDK — bedrock, anthropic, openai, google, ollama)                                                    | Done (14.2-14.4 deferred)  |
| **18** | CLI Polish & Distribution (init, list, destroy, completions, npm/brew, GH Action)                                                          | Done                       |
| **19** | Intelligence Layer (IAM MCP, WA Security MCP, memory system, status, billing)                                                              | Done                       |
| **20** | MCP Server (plan, apply, list, estimate tools for AI agents)                                                                               | Done                       |
| **22** | Auto-Fix Round (apply auto-fixable BP patches with user consent)                                                                           | Done                       |
| **23** | Real-Time Pricing Breakdown (live pricing via AWS Pricing MCP, zero hardcoded $)                                                           | Done                       |
| **24** | Instance Type Selection UX (category filters, workload classification)                                                                     | Done                       |
| **25** | Sprint F — Tier 1 Resources (LogGroup, IGW, RouteTable, Route, NatGateway)                                                                 | Done                       |
| **26** | Sprint G — Tier 2 Resources (ApiGatewayV2, CloudWatch Alarm, SecretsManager)                                                               | Done                       |
| **27** | Config Precedence (user, project, org policy, env overrides, CLI flags)                                                                    | Done                       |
| **28** | Drift Detection (`assignee drift`, `assignee reconcile`)                                                                                   | Done                       |
| **29** | MCP Connection Pre-Warming & Resilience                                                                                                    | Done (29.4 deferred)       |
| **30** | Request/Response Recording & Replay                                                                                                        | Done                       |
| **31** | CloudFormation Schema SDK Migration (direct SDK, no MCP dependency)                                                                        | Done                       |
| **33** | Auto-Cleanup (checkpoints, cache rotation, memory TTL)                                                                                     | Done                       |
| **34** | Quality Hardening (node robustness, code splitting, error compensation)                                                                    | Done                       |
| **35** | Actionable Findings (interactive fix selection, fix hints, fix categories)                                                                 | Done                       |
| **37** | Static Site Deploy (`--source`, S3 upload, CloudFront + OAC)                                                                               | Done                       |
| **38** | Full Codebase Hardening (bounds checks, timeout caps, input validation)                                                                    | Done                       |
| **50** | Positioning, Bloat Cut, Publish Prep                                                                                                       | In progress                |

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

| Document              | Location                                                 |
| --------------------- | -------------------------------------------------------- |
| Documentation Index   | [docs/index.md](docs/index.md)                           |
| Architecture Flows    | [docs/architecture-flows.md](docs/architecture-flows.md) |
| Commands Reference    | [docs/commands.md](docs/commands.md)                     |
| Resource Types        | [docs/resource-types.md](docs/resource-types.md)         |
| Best Practices Engine | [docs/best-practices.md](docs/best-practices.md)         |
| AWS Setup Guide       | [docs/aws-bootstrap.md](docs/aws-bootstrap.md)           |
| Troubleshooting       | [docs/troubleshooting.md](docs/troubleshooting.md)       |

---

## License · Contributing · Security

- **License:** MIT — see [LICENSE](LICENSE).
- **Contributing:** see [CONTRIBUTING.md](CONTRIBUTING.md) for the dev loop, pre-commit expectations, and the BMAD story workflow.
- **Security:** see [SECURITY.md](SECURITY.md) for vulnerability reporting and the supported-versions policy.
- **Changelog:** see [CHANGELOG.md](CHANGELOG.md). **Code of conduct:** [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
