# AI Architecture — how assignee.ai turns English into AWS

> **Scope of this doc.** `docs/architecture.md` describes the monorepo layout and the LangGraph StateGraph mechanics. This file zooms in on **the AI parts** — what the language models decide, what the MCP servers contribute, what stays rule-based, and where the human sits in the loop. Read this first if you want to understand _why_ the pipeline is shaped the way it is.
>
> Every claim below cites exact file:line against HEAD. If you suspect drift, grep the source — the project policy is code-truth over doc-prose.

## Table of contents

- [1. What AI does in this project](#1-what-ai-does-in-this-project)
- [2. The 15-node pipeline, at a glance](#2-the-15-node-pipeline-at-a-glance)
- [3. Node classification — LLM / MCP / rule / plumbing](#3-node-classification--llm--mcp--rule--plumbing)
- [4. The LLM layer — providers, sanitization, cost](#4-the-llm-layer--providers-sanitization-cost)
- [5. The MCP layer — five MCP servers (2 core, 3 optional)](#5-the-mcp-layer--five-mcp-servers-2-core-3-optional)
- [6. The Best Practices engine — deterministic, not AI](#6-the-best-practices-engine--deterministic-not-ai)
- [7. Human-in-the-loop — the interrupt that gates every apply](#7-human-in-the-loop--the-interrupt-that-gates-every-apply)
- [8. What this repo exports as MCP tools](#8-what-this-repo-exports-as-mcp-tools)
- [8.5. Recent architectural additions](#85-recent-architectural-additions)
- [9. A real end-to-end run](#9-a-real-end-to-end-run)
- [10. Design choices and tradeoffs](#10-design-choices-and-tradeoffs)

---

## 1. What AI does in this project

The product promise is simple: **type an AWS intent in English → get a real, tagged, cost-estimated AWS resource, after a human says yes**. The AI layer is how English becomes a concrete CloudFormation CloudControl plan. But the architecture is deliberately restrained — the model is responsible for three specific decisions, and everything else is either deterministic rules or live AWS data.

The three LLM responsibilities (decomposed into **four callsites** across the graph — see §3 and §9):

1. **Classification.** Given `"Create an S3 bucket named logs-prod"`, decide that the target is `AWS::S3::Bucket` and (if applicable) which compound pattern to dispatch. Two callsites carry this responsibility: `intent_parser` (resource-type / pattern selection) and `workload_classifier` (workload-profile inference invoked from inside `option_elicitor` to rank instance-type options).
2. **Generation.** Turn the classified intent + the CloudFormation schema into a `desiredState` JSON blob that CloudControl will accept. One callsite: `plan_generator`.
3. **Advice.** Generate human-readable hints (cost, security, architecture) to display alongside the plan — advisory, never load-bearing. One callsite: `advice_generator`.

Everything else that _feels_ AI-ish is not:

- **Cost estimates** come from the AWS Pricing MCP server at runtime. No model hallucinates dollars.
- **IAM pre-checks** come from the IAM MCP server via `simulate_principal_policy`. No model guesses whether a policy will work.
- **Best-practice findings** come from deterministic YAML rules (count: see `packages/best-practices/manifest.json`). Only the advice explainers are LLM-generated; the findings themselves are not.
- **Security posture** comes from the Well-Architected Security MCP server reading SecurityHub / GuardDuty / Config. No model speculates about findings.
- **Plan approval** is the user's call, always. The graph compiles with an `interruptBefore` that forces a human to type "Yes" before any `CreateResource` fires.

The architectural rule: **LLMs translate, MCP servers report, rules enforce, humans authorize.** A mistake in any one layer is caught by the next.

## 2. The 15-node pipeline, at a glance

`packages/core/src/graph/create-graph.ts` declares 15 nodes in a LangGraph `StateGraph`. <!-- doc-lint: node-count --> Pipeline shape (abbreviated — full routing in §3):

```
          ┌──────────────────── Phase 1: planning ─────────────────────┐
START  ▶  intent_parser  ▶  schema_fetcher  ▶  option_elicitor
                                                     │
                                           compound_dispatcher
                                                     │
                                            plan_generator ◀─┐
                                                     │       │
                                    validate_desired_state   │  (compound
                                                     │       │   loop)
                                            advice_generator │
                                                     │       │
                                              bp_evaluator   │
                                                     │       │
                                             fix_applicator  │
                                                     │       │
                                             preflight_guard │
                                                     │       │
                                              human_approval │  ◀── HITL stop
          └──────── interruptBefore:                         │
                    [resource_provisioner] ──────────────────│
          ┌──────────────────── Phase 2: provisioning ───────┘
                                                     │
                                          resource_provisioner
                                                     │
                                             status_poller (self-loop)
                                                     │
                                           result_formatter  ▶  END
```

The split into two phases exists because the CloudControl `CreateResource` call mutates the user's real AWS account. Everything up to `human_approval` is safe to replay — no side effects. Everything after `resource_provisioner` is irreversible without a destroy run. The HITL interrupt sits exactly on that boundary.

`create-graph.ts:410` pins the interrupt:

```typescript
interruptBefore: [GraphNode.RESOURCE_PROVISIONER],
```

## 3. Node classification — LLM / MCP / rule / plumbing

Each node is classified by what it _consumes_. The point is to show that only three nodes actually make LLM calls; most of the work is either deterministic or MCP-mediated.

| #   | Node                     | LLM? (callsite)               | MCP? (server)                                | Rule?                                                  | What it does                                                                                                                                                                                                                                                   |
| --- | ------------------------ | ----------------------------- | -------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `intent_parser`          | **Yes** (intent_parser)       | —                                            | —                                                      | Classify English → `resourceType` or a compound pattern. Falls back to regex-based pattern matching if the LLM is uncertain.                                                                                                                                   |
| 2   | `schema_fetcher`         | —                             | —                                            | —                                                      | Direct CloudFormation `DescribeType` SDK call. Pure plumbing.                                                                                                                                                                                                  |
| 3   | `option_elicitor`        | **Yes** (workload_classifier) | Pricing (parallel)                           | —                                                      | Interactive wizard for field values. Fires pricing lookups in parallel so the plan box shows live cost as soon as config is decided. Invokes `classifyWorkload` (callsite `"workload_classifier"`) via `parallel-enrichment.ts` to rank instance-type options. |
| 4   | `compound_dispatcher`    | —                             | —                                            | —                                                      | Pure function. Flattens a compound pattern's `resourceList` into a sequential `resourceQueue`.                                                                                                                                                                 |
| 5   | `plan_generator`         | **Yes** (plan_generator)      | —                                            | —                                                      | LLM turns `resourceType + schema + elicitedOptions` into `desiredState` JSON. Compound patterns short-circuit the LLM call and use `defaultOptions` instead.                                                                                                   |
| 6   | `validate_desired_state` | —                             | —                                            | Schema constraint checks                               | Validates the generated `desiredState` JSON against CloudFormation schema constraints before passing to the advice layer.                                                                                                                                      |
| 7   | `advice_generator`       | **Yes** (advice_generator)    | Documentation, Pricing, WA-Security          | Rule-based hint set (first pass)                       | Rule-based hints first (fast, deterministic), MCP-enrichment second (live data), LLM polish third (readability only).                                                                                                                                          |
| 8   | `bp_evaluator`           | —                             | Documentation, WA-Security (enrichment only) | **Yes** — deterministic YAML rules                     | Evaluates deterministic rules (count: see `packages/best-practices/manifest.json`) against `desiredState`. MCP enrichment adds live context (e.g., SecurityHub findings) but doesn't drive the pass/fail decision.                                             |
| 9   | `fix_applicator`         | —                             | —                                            | —                                                      | Applies `desiredStatePatch` from auto-fixable findings; runs interactive prompts for user-gated fixes.                                                                                                                                                         |
| 10  | `preflight_guard`        | —                             | Pricing, IAM                                 | Placeholder-ARN, required-field, managed-policy guards | Parallel fan-out: pricing breakdown + IAM `simulate_principal_policy`. Fails closed if the operator can't actually perform the CloudControl action.                                                                                                            |
| 11  | `human_approval`         | —                             | —                                            | —                                                      | Renders the plan box (boxen on TTY, plain on pipe), reads user confirm. Sole gate on the `interruptBefore` boundary.                                                                                                                                           |
| 12  | `resource_provisioner`   | —                             | —                                            | —                                                      | CloudControl `CreateResource`. Writes `requestToken` + `resourceArn` into state.                                                                                                                                                                               |
| 13  | `status_poller`          | —                             | —                                            | —                                                      | Polls CloudControl until the request is terminal. Self-loops with `POLL_INTERVAL_MS = 2_000` (see `status-poller.ts:22`). Extended timeout (`20 * 60 * 1000`) for slow resources like CloudFront / RDS.                                                        |
| 14  | `result_formatter`       | —                             | —                                            | —                                                      | Terminal rendering. Routes to `SUCCESS` / `FAILED` / `CANCELLED` / plan-mode formatters. Emits `BP_BLOCKED` envelope when a blocking BP finding prevented provisioning.                                                                                        |
| 15  | `query_handler`          | —                             | —                                            | —                                                      | Query-intent routing branch. Reached from `intent_parser` when `executionStatus === QUERY_INTENT` (see `graph-routing.ts:34/37`). Handles read-only queries (e.g. "what resources do I have?") without entering the creation pipeline.                         |

**Plumbing nodes** (classified neither as LLM nor MCP): `schema_fetcher`, `compound_dispatcher`, `validate_desired_state`, `human_approval`, `resource_provisioner`, `status_poller`, `fix_applicator`, `result_formatter`, `query_handler`. More than half the pipeline is deterministic.

**LLM callsites — four total**: `intent_parser`, `workload_classifier` (invoked from `option_elicitor`), `plan_generator`, `advice_generator`. The `option_elicitor` row above is the easy one to miss — its LLM use is delegated to `classifyWorkload`, which carries its own `"workload_classifier"` callsite for token-cost grepping.

## 4. The LLM layer — providers, sanitization, cost

### Providers

`packages/core/src/constants/llm-providers.ts:11-17` declares five supported provider families:

- `bedrock` — AWS Bedrock (default; uses `createAmazonBedrock` with operator creds)
- `anthropic` — Anthropic API
- `openai` — OpenAI API
- `google` — Google AI (Gemini)
- `ollama` — local-model endpoint

A model string is formatted `provider/model-id` (e.g., `bedrock/us.amazon.nova-lite-v1:0` or `anthropic/claude-sonnet-4-5`). Parsing + validation lives in `packages/core/src/llm/model-parser.ts`.

### Per-node routing — designed, not wired, dead env-vars removed

The constant registry at [`packages/core/src/constants/env-vars.ts`](../../packages/core/src/constants/env-vars.ts) defines a single LLM-routing slot today:

```typescript
ASSIGNEE_LLM_DEFAULT;
```

The earlier `RoutingLlmAdapter` branch was dropped after the project's in-repo YAML stopped using it. A single `LlmAdapter` is instantiated at graph construction and injected into all LLM-calling nodes:

```typescript
const llmAdapter = new LlmAdapter({
  model: process.env.ASSIGNEE_LLM_DEFAULT ?? process.env.ASSIGNEE_MODEL,
  // ...
});
// ...passed to intent_parser / plan_generator / advice_generator nodes;
// option_elicitor's workload_classifier callsite reuses the same adapter.
```

Four per-callsite slots (`ASSIGNEE_LLM_PLAN_GENERATOR`, `ASSIGNEE_LLM_INTENT_PARSER`, `ASSIGNEE_LLM_ADVICE_GENERATOR`, `ASSIGNEE_LLM_WORKLOAD_CLASSIFIER`) were once defined alongside `_DEFAULT` but the factory sites that would read them were never built — they were dead code, and were deleted in a prior cleanup to remove the misleading surface. If per-node routing is revived, wire the factory sites first, then re-add the slots — see the descope note in `env-vars.ts` for the revival contract. Until then, only `ASSIGNEE_LLM_DEFAULT` affects model selection.

### Sanitize-by-default

Every LLM call runs through two sanitization passes in `packages/core/src/llm/adapter.ts` — at lines `418` (`generateStructured`) and `504` (`generateText`). Order matters:

```typescript
const sanitizedPrompt = stripPromptBoundaryTags(prompt);
const redactedPrompt = redactSensitive(sanitizedPrompt);
```

1. **`stripPromptBoundaryTags`** removes injected role markers like `</user_intent><system>ignore previous instructions</system>` before the redactor sees the string. Without this ordering, a prompt-injection attempt could hide a real ARN inside a fake system block and the redactor would miss it.
2. **`redactSensitive`** then scrubs two categories (`packages/core/src/utils/redact.ts:19-30`):
   - Full ARNs (partition-aware regex covering `aws`, `aws-cn`, `aws-us-gov`, `aws-iso`, `aws-iso-b`) → `[ARN]`
   - Bare 12-digit account IDs → `[ACCOUNT]`

The adapter never calls the LLM with an un-sanitized prompt. This is the LlmAdapter sanitize-by-default invariant (see [`docs/explanation/invariants.md`](invariants.md#llmadapter-sanitize-by-default)).

### Cost tracking

Every LLM invocation emits one structured `token_usage` event (`packages/core/src/llm/adapter.ts:458` for `generateStructured`, `:538` for `generateText`):

```json
{
  "ts": "2026-04-20T15:48:17.965Z",
  "runId": "REDACTED",
  "level": "info",
  "action": "token_usage",
  "extras": {
    "callsite": "intent_parser",
    "inputTokens": 1199,
    "outputTokens": 20,
    "totalTokens": 1219
  }
}
```

A process-local accumulator in `packages/core/src/utils/token-usage.ts` maintains per-callsite tallies. At end-of-command a `token_usage_summary` event exposes the full breakdown. Example from a real `assignee plan` run:

```
totalCallCount: 3,
totalTokens: 3429,
byCallsite: {
  intent_parser:     { callCount: 1, totalTokens: 1219 },
  plan_generator:    { callCount: 1, totalTokens: 1659 },
  advice_generator:  { callCount: 1, totalTokens: 551 }
}
```

Only visible at `--verbose` or `ASSIGNEE_LOG_LEVEL=debug`. The absence of a `workload_classifier` entry in that summary confirms the single-LLM-adapter pattern: the other callsites in the constant registry are unused in this run.

### Bedrock-specific plumbing

Bedrock gets a little extra wrapping because AWS gates its models by region. `packages/core/src/llm/bedrock-region.ts:18-55` wraps Bedrock access errors with actionable hints: if the current `AWS_REGION` is in the `KNOWN_BEDROCK_REGIONS` list, the user is told to request model access; if the region isn't in the list, they're told to switch regions or pick a non-Bedrock provider. Guardrail env vars (`BEDROCK_GUARDRAIL_ID`, `BEDROCK_GUARDRAIL_VERSION`) are read once at adapter instantiation and applied only when the provider is Bedrock.

The adapter is constructed **lazily** — `LlmAdapter.getModel()` (in `packages/core/src/llm/adapter.ts`) only instantiates the language-model client on first call, and caches the instance for the rest of the process. One adapter per `assignee` invocation, shared across the three LLM nodes.

## 5. The MCP layer — five MCP servers (2 core, 3 optional)

MCP (Model Context Protocol) is how the pipeline talks to AWS with structured requests instead of hand-rolled SDK calls. The project pins exact versions so supply-chain updates are explicit (`packages/core/src/config/mcp-servers.ts:48-58`):

| Server                                     | Pin       | Role     | Invoked by                                               | What it gives                                                                               |
| ------------------------------------------ | --------- | -------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `aws-pricing-mcp-server`                   | `@1.0.27` | reader   | `preflight-guard`, `advice-generator`, `option-elicitor` | Live cost estimates + per-unit rate breakdowns                                              |
| `aws-documentation-mcp-server`             | `@1.1.20` | (public) | `advice-generator`, `bp_evaluator` enricher              | AWS doc search for contextual best-practice hints                                           |
| `aws-iam-mcp-server`                       | `@1.0.17` | auditor  | `preflight-guard`                                        | `simulate_principal_policy` — will the operator's IAM actually work?                        |
| `aws-well-architected-security-mcp-server` | `@0.1.7`  | auditor  | `bp_evaluator` enricher                                  | Live SecurityHub / GuardDuty / Config findings; storage encryption check; network TLS check |
| `aws-billing-cost-management-mcp-server`   | `@0.0.17` | reader   | optional enrichment                                      | Cost Explorer queries, Savings Plans, Compute Optimizer data                                |

### Credential isolation — the 3-user model

MCP subprocesses don't share credentials with the CLI. Each server gets **only** the AWS role it needs, via a gate function that refuses to fall through to `~/.aws/credentials` or SSO:

- **Operator** (`ASSIGNEE_OPERATOR_ACCESS_KEY_ID` / `_SECRET_ACCESS_KEY` / `_SESSION_TOKEN`) — used by the CLI itself for CloudControl CRUD + Bedrock invoke.
- **Reader** (`ASSIGNEE_READER_*`) — passed to Pricing and Billing MCP subprocesses. Scoped to Pricing API + Cost Explorer + schema reads.
- **Auditor** (`ASSIGNEE_AUDITOR_*`) — passed to IAM and Well-Architected-Security MCP subprocesses. Scoped to `iam:SimulatePrincipalPolicy` + SecurityHub read.

`requireAssigneeCredentials(role)` at `packages/core/src/config/aws-credentials.ts:122-150` throws `MissingAssigneeCredentialsError` if the required env vars are unset. Graceful degradation: reader-scoped servers are omitted from the MCP config if credentials are missing (Pricing/Billing just don't show up), and auditor servers swallow `MissingAssigneeCredentialsError` so the pipeline continues without IAM simulation — the operator still has the `preflight` guards that don't depend on MCP.

### Knowledge MCP and remote MCP gate (retired)

A sixth, opt-in `knowledge-mcp.global.api.aws` server and the `ASSIGNEE_ENABLE_REMOTE_MCP` flag were previously documented here. Both have been retired — the knowledge MCP is no longer registered in `packages/core/src/config/mcp-servers.ts`, and the env-var slot is no longer read. See `packages/core/src/constants/env-vars.ts` for the live registry.

## 6. The Best Practices engine — deterministic, not AI

The BP rules at `packages/best-practices/` (live count in [`manifest.json`](../../packages/best-practices/manifest.json)) are **pure, deterministic YAML** — there is no LLM in the enforcement path. The value of running rules alongside an LLM generator is exactly that the LLM can't silently omit an encryption flag or forget to block public access.

Each rule is a YAML file with a schema-validated structure:

```yaml
# packages/best-practices/s3/BP-S3-001.yaml (excerpt)
id: BP-S3-001
title: S3 bucket should block all public access
severity: HIGH
resource_type: AWS::S3::Bucket
property_path: PublicAccessBlockConfiguration.BlockPublicAcls
check_type: equals
expected_value: true
autoFixable: true
desiredStatePatch:
  PublicAccessBlockConfiguration:
    BlockPublicAcls: true
    BlockPublicPolicy: true
    IgnorePublicAcls: true
    RestrictPublicBuckets: true
fix_hint: "Set BlockPublicAcls + 3 siblings to true"
lastVerified: 2026-04-20
```

`evaluate()` at `packages/best-practices/src/evaluate/barrel.ts:24-69` matches rules to a plan by three criteria:

1. `resource_type` must match the plan's current `resourceType` (fast reject).
2. Optional `triggers[]` — at least one must match. Trigger fields: `resourceType`, `intentKeywords` (substring search on the user's English input), `patternId`, `always`.
3. `excludePatterns[]` — skip the rule if the current compound-pattern ID is on the list (prevents pattern-level rules from double-firing inside their own compound).

The check itself (`rule-runner.ts:checkPasses()`) is a small dispatch table: `equals`, `not_equals`, `exists`, `not_exists`, `contains`, `greater_than`, `less_than`, `regex`, `nested_array_check`, `any_of`, `custom`. No model is involved.

### Integrity — why the manifest hash matters

The BP library ships with a SHA-256 `manifest.json` that lists every rule file and its hash. On load, the CLI re-hashes every YAML and compares to the manifest. If any file's hash differs, the load fails closed — someone has modified a rule since it was shipped.

This is why the repo ships `.gitattributes` forcing LF line endings: without it, Windows checkouts would get CRLF-rewritten YAML, the computed hashes would differ from the Linux-generated manifest, and the integrity check would fail on every Windows machine. (The fix was confirmed by the first green cross-platform CI run after the matrix-dispatch bug was resolved.)

### Auto-fix is separate from evaluate

`evaluate()` produces `BPFinding[]` — records of what failed. A later node (`fix_applicator`) decides whether to apply the rule's `desiredStatePatch`:

- `autoFixable: true` + `fixType: auto` → patch is merged into `desiredState` without prompting.
- `autoFixable: true` + `fixType: interactive` → user gets a Y/N prompt.
- Everything else stays as a displayed warning.

This separation is intentional: the engine that _detects_ problems is the same deterministic code that runs in CI (via `pnpm citation-lint` + integrity hash), while the engine that _resolves_ them is the interactive CLI path.

## 7. Human-in-the-loop — the interrupt that gates every apply

The graph is compiled with a hard stop (`create-graph.ts:410`):

```typescript
compile({ interruptBefore: [GraphNode.RESOURCE_PROVISIONER] });
```

LangGraph's `interruptBefore` means the graph **saves its state and returns to the caller** before the named node runs. The CLI then:

1. Renders the plan box via `renderPlanBox` (`packages/core/src/utils/display-plan.ts:138-142,149,159`).
2. Writes a checkpoint to `.assignee/checkpoint-<runId>.json` (valid for 72 hours).
3. Asks "Apply now?" via the unified prompt at `packages/core/src/utils/display-prompts/confirms.ts:46`: `Apply now? (${resourceType}, est. ${costLabel})`.
4. Resumes the graph only on explicit user confirmation.

Three escape hatches:

- `--yes` auto-approves (for CI/CD). Still renders the plan for the log; still requires the graph to complete Phase 1 successfully (no preflight override).
- `--no-apply` on `plan` terminates after the box is rendered. No checkpoint-resume happens.
- `--checkpoint <path>` lets a later `apply` invocation resume Phase 2 directly from a saved Phase 1. Useful for "generate the plan on my laptop, apply it from CI".

Even with `--yes`, the apply is blocked if `preflight_guard` failed — the auto-approve flag approves a _passing_ plan, not a broken one.

## 8. What this repo exports as MCP tools

So far we've talked about the MCP servers the pipeline _consumes_. The project also _exports_ 5 MCP tools of its own — this is the `@assignee/mcp-server` app, meant to expose the CLI to AI coding assistants like Cursor or Claude Code:

1. **`plan_resource`** (`apps/mcp-server/src/tools/plan-resource.ts:49-60`) — runs the LangGraph PLAN graph internally, returns the `desiredState` + estimated cost without provisioning.
2. **`apply_plan`** — requires `confirmed: true` to execute. Calls the APPLY path and returns stack events.
3. **`list_managed_resources`** (`list-managed-resources.ts:29-45`) — queries AWS Resource Groups Tagging API for resources tagged `managed-by=assignee-ai`.
4. **`estimate_cost`** (`estimate-cost.ts:49+`) — fast-path pricing lookup via `PricingStrategyRegistry`. Doesn't run the full graph.
5. **`destroy_resource`** (`destroy-resource.ts:15-48`) — safely deletes a resource by ARN or slug. Requires `confirmed: true`.

All 5 are registered at `apps/mcp-server/src/tools/index.ts:15-21`. They go through the same 15-node graph as the CLI, which means the HITL interrupt fires _inside the MCP server call_ — an agent calling `apply_plan` without `confirmed: true` gets a rejection, not a silent provision.

## 8.6. Hexagonal port surface, persistence, and observability

The following features are architecturally significant — they affect the hexagonal port surface, the persistence safety model, and the observability pipeline.

### Hexagonal ports (port count: **7**)

Four ports were added to `packages/core/` (totaling seven ports across the package; all live under `packages/core/src/ports/`):

| Port               | Location                                        | Purpose                                                                                                                                                                                                                                          |
| ------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CheckpointerPort` | `packages/core/src/ports/checkpoint-port.ts`    | HITL checkpoint storage: `save` / `load` / `list` / `delete` / `prune`. Two adapters today: in-memory (dev/test) and file-durable (`~/.assignee/checkpoints/`, 0o600, atomic-write, HMAC-signed). Substrate for future distributed-store work.   |
| `AdvisoryLockPort` | `packages/core/src/ports/advisory-lock-port.ts` | Advisory lock for memory-persistence writes: `acquire` / `release` / `withLock`. File adapter uses `O_CREAT\|O_EXCL` atomic acquisition and 10 s stale-lock reclamation. Substrate for future distributed lock service.                          |
| `TelemetryPort`    | `packages/core/src/ports/telemetry-port.ts`     | Telemetry event emission: `emit` / `emitFiltered`. `InMemoryTelemetryAdapter` ring-buffer (cap 1 000). Active only when `ASSIGNEE_TELEMETRY_ADAPTER` is set (no vendor phone-home by default).                                                   |
| `OIDCPort`         | `packages/core/src/ports/oidc-port.ts`          | Identity validation scaffold: `validateToken` / `extractClaims` / `refreshToken`. In-memory fixture-backed adapter today; real Okta/AzureAD/Auth0 adapter deferred to future productisation work, out of scope for this course-submission build. |

### Sensitive-field marker layer

`ResourceField.sensitive?: boolean` was added to the plugin elicited-field type. `stripSensitiveFromElicited()` is invoked at every persistence boundary — pattern-memory writes, checkpoint writes, OTEL emission, failure-record `errorMessage`. This composes additively with the existing CFN property-name allowlist (`checkpoint/redaction.ts`) and the OTEL field allowlist (`telemetry/otel-allowlist.ts`). Fields annotated today: RDS `MasterUserPassword`, SecretsManager `SecretString`, EventBridge Connection `AuthParameters`.

### Audit log

`packages/core/src/audit/` — HMAC-chain primitive, verifier, and writer. See `docs/explanation/invariants.md § HMAC audit chain integrity` for the full contract.

### RBAC scaffolding

`packages/core/src/rbac/` — Zod policy schema, policy store (in-memory + file adapters), role-context resolver, five fixtures. No enforcement at command boundaries yet; enforcement is deferred to future productisation work, out of scope for this course-submission build.

### Partition-aware provisioning router

`packages/core/src/provisioning/ccapi-partition-support.ts` + `partition-aware-provisioner.ts`. Routes S3, IAM, and VPC resources through SDK-direct adapters for non-commercial partitions (GovCloud, China, ISO, iso-e); other types receive an actionable "not supported in `<partition>`" message. See `docs/explanation/invariants.md § Partition-aware provisioner as the CCAPI routing layer`.

### Telemetry pipeline

`OTEL_FIELD_ALLOWLIST` + `FIELD_PRIVACY_MAP` source-side allowlist (`otel-allowlist.ts`) with `@privacy: PII | SYSTEM | OPERATIONAL` classification. Per-graph-node spans (`telemetry/spans.ts`) at 14/15 node entry + exit. `redactLogContent()` line-by-line filter wired into the CI artefact-upload scrub (`scripts/scrub-logs-for-upload.ts`). See `docs/explanation/telemetry-design.md` for the full observability pipeline.

---

## 8.5. Recent architectural additions

The following features are architecturally significant — they affect what the AI pipeline does, how BP rules behave, and how errors are surfaced.

### Probe-gate methodology

Every change that ships a new BP rule or a new first-class type must also ship a dogfood probe in `PROBE_MANIFEST.yaml`. The probe gate (`pnpm citation-lint` step) verifies each probe fires on the intended intent before the commit can land. This is a methodology gate on the _test surface_, not a change to the pipeline itself — but it means the AI architecture's correctness claims are now backed by a required fire-probe per change.

### Multi-variation + tripwire forcing-flip

Probe entries now carry a `known_tripwires[]` array and `--strict-multi-variation` / `--tripwire-only` CLI flags. When `known_tripwires` is non-empty, the probe runner can verify that a given forcing phrase (an adversarial variation designed to trip the LLM into a wrong classification) is correctly rejected by `intent_parser`. This closes the loop between the ML classification node and the probe test surface: if a new keyword alias causes a regression, the probe manifest catches it before CI green.

### `BP_BLOCKED` error envelope

`apply.ts` emits a discriminated `ApplyFailureDetail` with `kind: "bp_blocked"` when a blocking BP finding prevents provisioning, distinct from `kind: "apply_failed"` (CCAPI error). This means:

- Exit code 10 covers both, but the machine-readable `--json` output distinguishes the two causes.
- MCP `apply_plan` callers can detect a BP block without parsing human-readable text.
- The `result_formatter` node emits the `BP_BLOCKED` envelope; see `packages/core/src/constants/errors.ts`.

### Secure-by-default backfill allowlist

`LLM_PATH_PLUGIN_DEFAULT_BACKFILL_ALLOWLIST` (live entries: see source) covers types like `SNS_TOPIC`, `SQS_QUEUE`, `EC2_ROUTE`, `EC2_NAT_GATEWAY`, `ELBV2_LOAD_BALANCER`, `RDS_DB_INSTANCE`, `ECS_CLUSTER`, `ECR_REPOSITORY`, `EFS_FILE_SYSTEM`, `APIGATEWAYV2_API`, `CLOUDFRONT_DISTRIBUTION`. When `plan_generator` produces a `desiredState` that omits optional security fields (e.g., `MultiAZ`, `DeletionProtection`), the backfill step applies the plugin's opinionated defaults before `bp_evaluator` runs — reducing noise from fixable violations and ensuring the HITL plan box shows a more complete picture. Types not on the allowlist get no backfill (explicit opt-in required by the plugin author).

### New BP `check_type` extensions

The BP rule-runner dispatch table (`packages/best-practices/src/evaluate/rule-runner.ts`) now handles two additional `check_type` values beyond the original set:

- **`nested_array_predicate`** — evaluates a predicate function against every element of a nested array in `desiredState` (e.g., all `Statement[]` entries in a policy document must satisfy a condition).
- **`policy_antipattern`** — detects known dangerous IAM policy patterns (wildcard actions, overly broad resources, missing conditions) at the property-path level.

These extend §6's check-type table. Any BP YAML that references `nested_array_predicate` or `policy_antipattern` as `check_type` requires the updated engine; older CLI builds will fall through to the `default` branch and pass silently (a known gap tracked in the project backlog).

### Elastic IP (EIP) first-class promotion

`AWS::EC2::EIP` is a first-class CCAPI type (live count of supported types: see `packages/core/src/config/resource-types/supported.ts`). It has a dedicated pricing decomposer and plugin, and appears as a named resource in the VPC Networking compound pattern. The `intent_parser` resolves "elastic ip", "eip", "allocate ip" to `AWS::EC2::EIP` at zero LLM latency via keyword matching.

## 9. A real end-to-end run

The best way to understand the pipeline is to watch it run. Here's the token-usage summary from an actual `assignee plan "Create an S3 bucket named hero-demo-bucket"` invocation on 2026-04-20 (run-id `REDACTED`):

```
plan_started           → intent="Create an S3 bucket named hero-demo-bucket"
config_loaded          → .assignee/config.yaml (project)
token_usage            → callsite=intent_parser       totalTokens=1219
intent_parsed          → resourceType=AWS::S3::Bucket, pattern=null
token_usage            → callsite=plan_generator      totalTokens=1659
plan_generated         → resourceType=AWS::S3::Bucket (960ms)
pricing_unavailable    → advisoryPriceId=alb-monthly (harmless — other resource)
token_usage            → callsite=advice_generator    totalTokens=551
advice_generated       → hintCount=5 (3361ms)
bp_evaluated           → findingsCount=10, criticals=0, highs=5
preflight_completed    → parallelFanOut=433ms (pricing+iam fulfilled)
preflight_completed    → costEstimate="$0.0230/GB-month"
result_formatted       → executionStatus=PENDING
token_usage_summary    → totalCallCount=3, totalTokens=3429
```

Three LLM calls (3429 tokens) + one pricing MCP fetch + one IAM simulate + the full BP rule set evaluated (live count in [`manifest.json`](../../packages/best-practices/manifest.json)), all before the human sees the plan box. Total wall-clock ~6 seconds from typing to "Apply now?". (Note: only three callsites fired in this run — `intent_parser` / `plan_generator` / `advice_generator`. `workload_classifier` is the fourth callsite but only fires when `option_elicitor` reaches an instance-type-ranking field; this S3 plan didn't trigger it.)

## 10. Design choices and tradeoffs

A few decisions that stand out, each with a short rationale:

**Why LangGraph instead of a plain async pipeline?**
LangGraph gives two things for free that would be painful hand-rolled: (a) checkpoint + replay, which is what makes the HITL interrupt work — the graph can be persisted at any edge and resumed later on a different machine; and (b) the routing-function abstraction, which makes compound patterns (where `result_formatter` loops back to `plan_generator` for the next resource in the queue) explicit and testable.

**Why constrain the LLM to four callsites?**
Fewer LLM calls = fewer places for hallucination to silently propagate. Every non-LLM node is either a pure function (deterministic, unit-testable) or a call to a live AWS service (ground truth). The LLM is the _only_ layer allowed to make intent-level judgments; everything downstream validates against reality. A side benefit is per-command cost visibility: the structured `token_usage_summary` event tells you exactly which callsite consumed how many tokens.

**Why run rule-based BP rules on top of LLM output?**
Because an LLM _will_ sometimes produce a technically-valid plan that omits an encryption flag or enables public access. Running deterministic rules after generation (live count in [`manifest.json`](../../packages/best-practices/manifest.json)) catches the model's blind spots cheaply — the whole evaluation is under 10ms, versus multi-second LLM round-trips. The BP engine is load-bearing; the advice generator's hints are decoration.

**Why MCP servers for pricing and IAM instead of direct SDK?**
Three reasons: (1) the MCP protocol is a clean seam for LLM-side tools to see the same data without the CLI needing to re-serialize — the 5 exported MCP tools and the 5 consumed MCP servers share interfaces; (2) supply-chain pinning — updating a server version is a deliberate bump of `MCP_PINS`, not a silent upstream NPM drift; (3) credential isolation — the 3-user model (operator/reader/auditor) is enforced at the subprocess boundary, because each server gets a different env block.

**Why the HITL interrupt instead of a dry-run flag?**
A `--dry-run` is an opt-in — the dangerous default is "apply immediately". `interruptBefore` inverts that: the dangerous default is "stop and ask". Combined with the typed-confirmation `--yes` escape hatch for CI/CD, this hits the safety-vs-ergonomics point the product was aiming for.

**What's deliberately not built in yet?**
Per-node LLM routing (§4) is the biggest one — the per-callsite env-var slots were deleted in a prior cleanup, and the `RoutingLlmAdapter` was removed earlier when the in-repo YAML stopped using it. The routing surface stub remains in `env-vars.ts` should it be revived; until then, only `ASSIGNEE_LLM_DEFAULT` affects model selection. When there's a real workload where `plan_generator` wants Claude and `intent_parser` wants Nova-micro, the routing can come back. Similarly, the config-file `llm:` section is documented-as-planned (`docs/configuration.md`) but only ENV vars work today, and even that env-var surface is limited to `ASSIGNEE_LLM_DEFAULT`. Writing this honestly here is the fix-everything-you-find policy applied to the doc itself.

---

## Further reading

- `docs/architecture.md` — monorepo layout + LangGraph state schema + pricing registry internals
- `docs/architecture-flows.md` — end-to-end flow diagrams for plan / apply / destroy / drift
- `docs/integration-architecture.md` — how `apps/cli`, `apps/mcp-server`, and `@assignee/core` fit together
- `docs/explanation/invariants.md` — load-bearing rules enforced across the codebase (partition-aware ARN, CCAPI NotFound short-circuit, prompt-boundary strip, BP manifest integrity, etc.)
- `docs/explanation/oss-vs-saas.md` — which parts stay OSS vs eventually monetize, and why
- `docs/best-practices.md` — BP rule authoring reference
- `docs/mcp-servers.md` — consumed MCP server pins + tool surface
- `docs/mcp-server.md` — exposing the CLI as an MCP server to IDEs
