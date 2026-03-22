# Assignee.ai

> AI-Native Cloud Operator — convert natural language into AWS infrastructure, safely.

```
assignee plan "Create an S3 bucket named my-app-assets"
assignee apply "Create an S3 bucket named my-app-assets"
```

[![CI](https://github.com/SergSlon/assignee-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/SergSlon/assignee-ai/actions/workflows/ci.yml)

---

## How it works

1. **Plan** — you describe intent in plain English; Bedrock Nova Lite parses it, fetches the CloudFormation schema, and interactively elicits resource options before generating a validated `desiredState` JSON with a cost estimate
2. **Approve** — you review the plan in the terminal and confirm (HITL)
3. **Apply** — Cloud Control API provisions the resource; tags are injected, State Guard prevents stale-plan overwrites, status is polled until terminal state

```
intent_parser → schema_fetcher → option_elicitor → plan_generator → preflight_guard
    → human_approval ─[HITL interrupt]─ → resource_provisioner → status_poller → result_formatter
```

All AI calls stay local — no AWS credentials ever leave your machine.

---

## Quick start

### Prerequisites

- Node.js 22+
- pnpm 10+
- Python 3.10+ with `uvx` (`pip install uv`)
- Two IAM users with the policies below (full setup: [docs/aws-bootstrap.md](docs/aws-bootstrap.md))

#### Required IAM users and policies

Two users are required — one for Bedrock AI calls, one for MCP server subprocesses:

| User               | Env vars                                              | Policy                | Purpose                                |
| ------------------ | ----------------------------------------------------- | --------------------- | -------------------------------------- |
| `bedrock-dev-user` | `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY`         | `AssigneeAiPocPolicy` | Bedrock Nova Lite invocation           |
| `aws-mcp-user`     | `MCP_AWS_ACCESS_KEY_ID` / `MCP_AWS_SECRET_ACCESS_KEY` | `AssigneeAiMcpPolicy` | CCAPI, CFN schema, pricing MCP servers |

**`AssigneeAiPocPolicy`** (attach to `bedrock-dev-user`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "BedrockInvokeNovaScopedOnly",
      "Effect": "Allow",
      "Action": ["bedrock:InvokeModel"],
      "Resource": "arn:aws:bedrock:*::foundation-model/amazon.nova-lite-v1:0"
    },
    {
      "Sid": "CloudControlScopedToSupportedTypes",
      "Effect": "Allow",
      "Action": [
        "cloudcontrol:CreateResource",
        "cloudcontrol:GetResourceRequestStatus",
        "cloudcontrol:GetResource"
      ],
      "Resource": "*",
      "Condition": {
        "StringEquals": {
          "cloudcontrol:TypeName": [
            "AWS::S3::Bucket",
            "AWS::SSM::Parameter",
            "AWS::IAM::Role"
          ]
        }
      }
    },
    {
      "Sid": "XRayTracing",
      "Effect": "Allow",
      "Action": ["xray:PutTraceSegments", "xray:PutTelemetryRecords"],
      "Resource": "*"
    }
  ]
}
```

**`AssigneeAiMcpPolicy`** (attach to `aws-mcp-user`):

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "CloudControlScopedToSupportedTypes",
      "Effect": "Allow",
      "Action": [
        "cloudcontrol:CreateResource",
        "cloudcontrol:GetResource",
        "cloudcontrol:GetResourceRequestStatus",
        "cloudcontrol:ListResources"
      ],
      "Resource": "*",
      "Condition": {
        "StringEquals": {
          "cloudcontrol:TypeName": [
            "AWS::S3::Bucket",
            "AWS::SSM::Parameter",
            "AWS::IAM::Role"
          ]
        }
      }
    },
    {
      "Sid": "S3BucketProvisioning",
      "Effect": "Allow",
      "Action": [
        "s3:CreateBucket",
        "s3:DeleteBucket",
        "s3:GetBucketLocation",
        "s3:GetBucketTagging",
        "s3:PutBucketTagging",
        "s3:ListBucket"
      ],
      "Resource": "*"
    },
    {
      "Sid": "SSMParameterProvisioning",
      "Effect": "Allow",
      "Action": [
        "ssm:PutParameter",
        "ssm:GetParameter",
        "ssm:DeleteParameter",
        "ssm:AddTagsToResource",
        "ssm:ListTagsForResource"
      ],
      "Resource": "*"
    },
    {
      "Sid": "IAMRoleProvisioning",
      "Effect": "Allow",
      "Action": [
        "iam:CreateRole",
        "iam:GetRole",
        "iam:DeleteRole",
        "iam:PutRolePolicy",
        "iam:AttachRolePolicy",
        "iam:DetachRolePolicy",
        "iam:DeleteRolePolicy",
        "iam:TagRole",
        "iam:ListRoleTags",
        "iam:PassRole"
      ],
      "Resource": "*"
    },
    {
      "Sid": "CloudFormationSchemaRead",
      "Effect": "Allow",
      "Action": ["cloudformation:DescribeType", "cloudformation:ListTypes"],
      "Resource": "*"
    },
    {
      "Sid": "PricingRead",
      "Effect": "Allow",
      "Action": [
        "pricing:GetProducts",
        "pricing:DescribeServices",
        "pricing:GetAttributeValues"
      ],
      "Resource": "*"
    },
    {
      "Sid": "XRayTracing",
      "Effect": "Allow",
      "Action": ["xray:PutTraceSegments", "xray:PutTelemetryRecords"],
      "Resource": "*"
    }
  ]
}
```

> No wildcards on `Action` — all permissions follow least-privilege (NFR-13).

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
```

### Supported resource types (POC)

| Type                                        | Notes                                                      |
| ------------------------------------------- | ---------------------------------------------------------- |
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

### Compound architecture patterns

Multi-resource intents are detected by keyword matching (zero LLM latency) and provisioned in dependency order:

| Pattern            | Resources                                    | Trigger keywords                    |
| ------------------ | -------------------------------------------- | ----------------------------------- |
| Serverless API     | IAM Role → Lambda → DynamoDB → API Gateway   | "serverless api", "lambda api"      |
| Static Website     | S3 Bucket (website-configured)               | "static website", "static site"     |
| Message Processing | SQS DLQ → SQS + DynamoDB + IAM Role → Lambda | "message queue", "event processing" |
| Three-Tier Web     | VPC → Subnet → SecurityGroup → ECS → ALB     | "three tier", "web application"     |
| Container Service  | ECR → ECS Cluster → IAM Role                 | "container service", "ecs"          |

---

## Architecture

```
apps/
  cli/
    src/
      commands/        plan.ts · apply.ts
      nodes/           intent-parser · schema-fetcher · option-elicitor
                       plan-generator · preflight-guard · human-approval
                       resource-provisioner · status-poller · result-formatter
      services/        graph.ts (LangGraph) · mcp-client.ts
      config/          mcp-servers.ts
      utils/           display.ts · logger.ts · tags.ts · mcp.ts · pricing-lookup.ts
      test-fixtures/   mcp-mock-responses.ts (real MCP captures)
    scripts/           capture → process → build fixture pipeline
packages/
  core/
    src/
      schema/          graph-state.ts (Zod — single source of truth)
      types/           result.ts (Result<T,E> monad)
      config/          resource-types.ts · resource-identifiers.ts · resource-policy.ts
      resource-plugins/  types.ts · registry.ts · index.ts
                         plugins/  s3-bucket · ec2-instance · rds-dbinstance
                                   lambda-function · generic
      pattern-templates/ registry.ts · types.ts
                         patterns/ serverless-api · static-website · message-processing
                                   three-tier-web · container-service
      errors.ts
```

**Key dependencies:**

- [`@langchain/langgraph`](https://langchain-ai.github.io/langgraphjs/) — agentic workflow orchestration
- [`@ai-sdk/amazon-bedrock`](https://sdk.vercel.ai/providers/ai-sdk-providers/amazon-bedrock) + [`ai`](https://sdk.vercel.ai/) — Bedrock Nova Lite via Vercel AI SDK
- [`@langchain/mcp-adapters`](https://github.com/langchain-ai/langchainjs/tree/main/libs/langchain-mcp-adapters) — MCP server bridge
- [`@clack/prompts`](https://github.com/bombshell-dev/clack) + `chalk` + `boxen` — terminal UX

**MCP servers (spawned at runtime via `uvx`):**

- `awslabs.cfn-mcp-server` — CloudFormation schemas (plan validation)
- `awslabs.aws-pricing-mcp-server` — live cost estimates (EC2, RDS, S3, SSM)
- `awslabs.aws-documentation-mcp-server` — AWS doc search, section reads, full page reads
- `awslabs.aws-knowledge-mcp-server` — configured but no app code calls its tools yet

> **Note:** CCAPI provisioning migrated from `ccapi-mcp-server` to `@aws-sdk/client-cloudcontrol` SDK (Story 7.6).

**Credential separation:**

- `AWS_*` env vars → `bedrock-dev-user` → Bedrock AI calls only
- `MCP_AWS_*` env vars → `aws-mcp-user` → MCP server subprocesses (CCAPI, CFN, pricing)

---

## Development

```bash
pnpm test          # run all tests (Vitest) — 188 tests across 20 files
pnpm check-types   # TypeScript type check
pnpm build         # compile all packages
```

Pre-commit hook runs: prettier → check-types → test.

### Test fixtures

All MCP mock responses in `apps/cli/src/test-fixtures/mcp-mock-responses.ts` are captured from live MCP servers (not fabricated). To refresh:

```bash
cd apps/cli/scripts
node capture-mcp-responses.mjs    # requires .env with MCP_AWS_* credentials
node process-captured-responses.mjs
node build-fixture-ts.mjs
```

Raw captures and processed intermediates are gitignored — only the final TypeScript fixture is committed.

---

## Project status

### POC scope — Epics 0–2 ✅ Complete

| Epic                  | Stories                                                                                                                                                | Status  |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| **0 — Foundation**    | Monorepo, `@assignee/core`, CLI scaffold, Vitest/CI, AWS bootstrap                                                                                     | ✅ Done |
| **1 — Plan command**  | LangGraph graph, MCP integration, `intent_parser`, `schema_fetcher`, `plan_generator`, `preflight_guard`, `assignee plan` CLI, terminal UX             | ✅ Done |
| **2 — Apply command** | `human_approval` (HITL), `resource_provisioner` (State Guard), `status_poller`, `result_formatter`, `assignee apply` CLI, IAM policy, resource tagging | ✅ Done |

### Epic 7 — Resource Intelligence (Phase A) ✅ Complete

| Story    | Description                                                                                                         | Status  |
| -------- | ------------------------------------------------------------------------------------------------------------------- | ------- |
| **7.0**  | Expand supported resource types (EC2, RDS, Lambda + 9 more)                                                         | ✅ Done |
| **7.1**  | `ResourcePlugin` interface + `PluginRegistry` + core plugins (S3, EC2, RDS, Lambda, generic)                        | ✅ Done |
| **7.3**  | `option-elicitor` node — interactive field elicitation, `showIf` conditionals, policy routing, non-TTY CI-safe path | ✅ Done |
| **7.5**  | Live EC2/RDS pricing enrichment in option-elicitor enum prompts                                                     | ✅ Done |
| **7.6**  | Migrate `ccapi-mcp-server` → `@aws-sdk/client-cloudcontrol` SDK                                                     | ✅ Done |
| **7.9**  | LLM-synthesized doc hints for `?` help input during option elicitation                                              | ✅ Done |
| **7.10** | Capture real MCP responses from all live servers — replace all fabricated test mocks                                | ✅ Done |

### Epic 8 — Compound Provisioning ✅ Complete

| Story   | Description                                                                             | Status  |
| ------- | --------------------------------------------------------------------------------------- | ------- |
| **8.1** | Pattern template registry + compound intent classifier (keyword matching, zero latency) | ✅ Done |
| **8.2** | Multi-resource sequential provisioning loop with dependency ordering                    | ✅ Done |
| **8.3** | Dependency plan display + compound provisioning UX                                      | ✅ Done |

### Epic 9 — Architecture Hardening ✅ Complete

| Story   | Description                                                       | Status  |
| ------- | ----------------------------------------------------------------- | ------- |
| **9.1** | Type-safe `ResourceType` literal union, remove `@ts-expect-error` | ✅ Done |
| **9.2** | Credential validation, `safeTry` adoption, typed SDK errors       | ✅ Done |
| **9.3** | Prompt injection guard — `sanitizeUserIntent` before Bedrock      | ✅ Done |
| **9.4** | Graph state/routing extraction, provisioning port                 | ✅ Done |
| **9.5** | MCP type extraction                                               | ✅ Done |
| **9.6** | Core package refactoring                                          | ✅ Done |

**AWS bootstrap (us-east-1, account 112233445566):**

- [x] Bedrock invocation logging → `/assignee-ai/bedrock-invocations` CloudWatch log group
- [x] `AssigneeAiPocPolicy` applied to `bedrock-dev-user`
- [x] `AssigneeAiMcpPolicy` applied to `aws-mcp-user`
- [x] CI green on GitHub Actions

---

### MVP scope — Epics 3–6 ❌ Not started

| Epic                        | Description                                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| **3 — Auth & Identity**     | `assignee login` via Browser OIDC; User ID / Org ID; Zero-Trust SaaS (no AWS keys server-side)                                  |
| **4 — Policy & Governance** | SaaS policy engine; Admin Block rules; `preflight_guard` → SaaS round-trip (<500ms); Panic Limit / cost cap; Bedrock Guardrails |
| **5 — Team & Spend**        | Admin invites developers; org monthly spend dashboard                                                                           |
| **6 — Audit & Compliance**  | Immutable WORM audit log; AWS X-Ray distributed tracing; Cost Anomaly Detection                                                 |

---

## NFR compliance (POC)

| NFR    | Requirement                                 | Status                              |
| ------ | ------------------------------------------- | ----------------------------------- |
| NFR-05 | `assignee plan` yields result in <3s        | ⚠️ Untested against live Bedrock    |
| NFR-08 | Unsupported types → actionable error        | ✅ Lists all 15 supported types     |
| NFR-10 | All Bedrock calls logged to CloudWatch      | ✅ Configured                       |
| NFR-11 | Every apply generates UUID v4 runId         | ✅ Implemented                      |
| NFR-12 | Structured JSON logs to stderr              | ✅ Implemented                      |
| NFR-13 | IAM least-privilege (no wildcards)          | ✅ Applied                          |
| NFR-14 | Mandatory tags on all provisioned resources | ✅ Implemented                      |
| NFR-15 | LLM calls capped at `maxTokens: 1024`       | ✅ Implemented                      |
| NFR-16 | Prompt injection guard                      | ✅ `sanitizeUserIntent` (Story 9.3) |

---

## Ops reference

See [docs/aws-bootstrap.md](docs/aws-bootstrap.md) for the full AWS account setup runbook (IAM policies, Bedrock logging, CloudWatch log group).
