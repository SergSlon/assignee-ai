---
diataxis: explanation
canonical: true
---

> **Diátaxis: Explanation** — This is the canonical root page for this topic. Background, design rationale, and architecture overview.

# Assignee.ai -- Technical Architecture

> Reverse-engineered from source code, April 2026.

## Monorepo Structure

```
assignee.ai/
  apps/
    cli/              -- Main CLI application (Commander.js)
    mcp-server/       -- MCP server for AI coding assistants
  packages/
    core/             -- Shared types, plugins, config, pricing
    best-practices/   -- YAML best-practice rules + evaluation engine
    eslint-config/    -- Shared ESLint configuration
    typescript-config/ -- Shared tsconfig bases
```

**Build system:** Turborepo + pnpm workspaces. TypeScript 5.9, Node.js >= 20. Vitest for testing.

## Dependency Graph

```
apps/cli
  depends on: @assignee/core, @assignee/best-practices

apps/mcp-server
  depends on: @assignee/core, @assignee/best-practices, assignee (CLI package)

packages/core
  depends on: @aws-sdk/client-cloudformation, zod

packages/best-practices
  depends on: yaml, zod
```

## LangGraph Agent Graph

The core computation is a **StateGraph** from `@langchain/langgraph` with 14 nodes.

### State (AgentState)

Defined in `packages/core/src/graph/graph-state.ts` as a LangGraph Annotation (canonical; `apps/cli/src/services/graph-state.ts` is a thin re-export shim). Key channels:

| Channel                    | Type                                         | Purpose                                       |
| -------------------------- | -------------------------------------------- | --------------------------------------------- |
| `userIntent`               | string                                       | Natural language input                        |
| `runId`                    | string (UUID)                                | Unique run identifier                         |
| `executionMode`            | PLAN / APPLY                                 | Whether to provision or just show plan        |
| `resourceType`             | string                                       | CloudFormation type (e.g., `AWS::S3::Bucket`) |
| `resourceSchema`           | Record                                       | CloudFormation schema for the resource        |
| `desiredState`             | Record                                       | Generated CloudFormation properties           |
| `elicitedOptions`          | Record                                       | User-confirmed wizard answers                 |
| `resourcePattern`          | ArchitecturePattern                          | Compound pattern (if detected)                |
| `resourceQueue`            | ResourceSpec[]                               | Ordered list of resources for compound        |
| `currentResourceIndex`     | number                                       | Current position in compound queue            |
| `completedResources`       | ResourceResult[]                             | Results of provisioned resources              |
| `executionStatus`          | PENDING/IN_PROGRESS/SUCCESS/FAILED/CANCELLED | Current state                                 |
| `bpFindings`               | BPFinding[]                                  | Best practice evaluation results              |
| `appliedFixes`             | AppliedFix[]                                 | Auto-applied BP patches                       |
| `estimatedMonthlyCost`     | string                                       | Cost estimate                                 |
| `pricingBreakdown`         | PricingBreakdown                             | Multi-line cost breakdown                     |
| `freeTierNote`             | FreeTierNote                                 | Free tier eligibility                         |
| `bpEnforcementLevel`       | enforce/warn/skip                            | BP blocking behavior                          |
| `autoApprove`              | boolean                                      | `--yes` flag for CI/CD                        |
| `noWizard`                 | boolean                                      | Skip interactive prompts                      |
| `checkpointResumed`        | boolean                                      | Resuming from saved plan                      |
| `orgConfig` / `userConfig` | Record                                       | Configuration from policies                   |

### Routing Functions

Defined in `packages/core/src/graph/graph-routing.ts` (canonical; `apps/cli/src/services/graph-routing.ts` is a thin re-export shim):

- **routeCheckpointEntry** (START): Checkpoint resumed with desiredState -> human_approval; otherwise -> intent_parser
- **routePreflightGuard**: Plan mode or preflight failed -> result_formatter; compound continuation -> resource_provisioner; otherwise -> human_approval
- **routeResourceProvisioner**: IN_PROGRESS -> status_poller; otherwise -> result_formatter
- **routeStatusPoller**: IN_PROGRESS -> self-loop; otherwise -> result_formatter
- **routeResultFormatter**: Compound with pending resources -> plan_generator (loop); otherwise -> END

### HITL Interrupt

The graph compiles with `interruptBefore: [resource_provisioner]`, creating a two-phase execution:

- **Phase 1**: intent_parser through human_approval (planning)
- **Phase 2**: resource_provisioner through result_formatter (provisioning), resumed after interrupt

## Plugin System

### Resource Plugins (`packages/core/src/resource-plugins/`)

Each plugin implements `ResourcePlugin`:

```typescript
interface ResourcePlugin {
  resourceType: string; // CloudFormation type
  commonFields: ResourceField[]; // Basic config questions (<=10)
  advancedFields: ResourceField[]; // Advanced options
  defaults: Record<string, unknown>;
  configHints?: string[]; // LLM prompt hints
  toCfn?: (state) => CfnOutput[];
  companionResources?: (state) => CfnOutput[];
}
```

38 registered plugins (37 resource-type plugins + 1 generic fallback). The 2 compound-only types `EC2::VPCGatewayAttachment` and `EC2::SubnetRouteTableAssociation` are routed to the generic fallback rather than having their own dedicated plugins. Plugins provide:

- Interactive wizard field definitions (type, label, options, validation, showIf conditions)
- toCfn transforms (boolean answers -> CloudFormation structures)
- Dynamic option fetching (AMIs, instance types, VPCs via AWS SDK)
- Companion resource generation (LogGroups, EIPs, etc.)

### Pattern Templates (`packages/core/src/pattern-templates/`)

Each pattern implements `ArchitecturePattern`:

- `patternId`: Identifier (e.g., "serverless-api")
- `triggerPatterns`: Regex patterns to match in user intent
- `resourceList`: Array of ResourceSpec with types and dependencies
- `dependencyOrder`: Array of arrays defining parallel/sequential execution
- `defaultOptions`: Default CloudFormation properties per resource

Registry uses `detect(intent)` to match patterns with zero LLM latency.

### Pricing Strategies (`packages/core/src/pricing/`)

Two registries:

1. **PricingStrategyRegistry** -- 38 strategies, one per registered resource type plugin. Each provides:
   - `estimate(desiredState)` -> local fallback label
   - `getMcpConfig(desiredState)` -> MCP query parameters for live pricing
2. **PricingDecomposerRegistry** -- 38 decomposers. Each returns `PricingLineItem[]` with service codes, filters, units for multi-line cost breakdowns. Counts verified by `pnpm doc-lint` (`patterns=11 types=38 strategies=38 decomposers=38`).

### Best Practices Engine (`packages/best-practices/`)

- 185 YAML rules organized by AWS service directory (s3/, ec2/, rds/, etc.); count matches `manifest.json`
- `loader.ts` reads YAML files, validates with Zod schema
- `evaluate.ts` runs trigger checks against `EvalContext` (resourceType + desiredState + userIntent + patternId)
- Check types: equals, not_equals, exists, not_exists, contains, not_contains, regex, comparison, nested_array_check, any_of, custom
- Each finding can be: blocking (prevents apply), auto-fixable (with desiredStatePatch), interactive (with options)

## Service Layer (Hexagonal Architecture)

### Ports

| Port               | Location                                        | Purpose                                                                 |
| ------------------ | ----------------------------------------------- | ----------------------------------------------------------------------- |
| `LlmPort`          | `packages/core/src/ports/llm-port.ts`           | Abstract LLM interface                                                  |
| `ProvisioningPort` | `apps/cli/src/services/provisioning-port.ts`    | Abstract CloudControl API                                               |
| `CheckpointerPort` | `packages/core/src/checkpoint/port.ts`          | HITL checkpoint storage (save/load/list/delete/prune)                   |
| `AdvisoryLockPort` | `packages/core/src/locks/advisory-lock-port.ts` | Advisory lock for memory persistence (acquire/release/withLock)         |
| `TelemetryPort`    | `packages/core/src/telemetry/telemetry-port.ts` | Telemetry event emission (emit/emitFiltered)                            |
| `OIDCPort`         | `packages/core/src/identity/oidc-port.ts`       | Identity validation scaffold (validateToken/extractClaims/refreshToken) |

### Adapters

| Adapter                          | Implements       | Purpose                                                                                                                                 |
| -------------------------------- | ---------------- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `LlmAdapter`                     | LlmPort          | Universal LLM via Vercel AI SDK                                                                                                         |
| `BedrockLlmAdapter`              | LlmPort          | Direct Bedrock adapter                                                                                                                  |
| `MockLlmAdapter`                 | LlmPort          | Testing adapter                                                                                                                         |
| `CloudControlAdapter`            | ProvisioningPort | AWS CloudControl API wrapper                                                                                                            |
| `InMemoryCheckpointerAdapter`    | CheckpointerPort | In-process checkpoint storage (default; test/dev)                                                                                       |
| `FileDurableCheckpointerAdapter` | CheckpointerPort | File-backed checkpoint storage (`~/.assignee/checkpoints/`, 0o600, atomic-write, HMAC-signed); substrate for Epic 102 Postgres/DynamoDB |
| `FileAdvisoryLockAdapter`        | AdvisoryLockPort | File-based advisory lock (`O_CREAT                                                                                                      | O_EXCL` acquisition, 10 s stale-lock reclamation); substrate for Epic 102 distributed lock service |
| `InMemoryTelemetryAdapter`       | TelemetryPort    | Ring-buffer telemetry sink (cap 1000 events); active only when `ASSIGNEE_TELEMETRY_ADAPTER` is set                                      |
| `InMemoryOIDCAdapter`            | OIDCPort         | Fixture-backed OIDC adapter (test only); real Okta/AzureAD/Auth0 adapter deferred to Epic 101                                           |

### Key Services

| Service                       | File                            | Purpose                                                                                                                                    |
| ----------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `graph.ts`                    | services/                       | LangGraph workflow construction                                                                                                            |
| `graph-state.ts`              | services/                       | State annotation definition                                                                                                                |
| `graph-routing.ts`            | services/                       | Conditional edge routing                                                                                                                   |
| `memory.ts`                   | services/                       | JSON-file provision/failure/pattern memory                                                                                                 |
| `checkpoint-state.ts`         | commands/apply/                 | Checkpoint save/resume state at apply time                                                                                                 |
| `checkpoint-writer.ts`        | commands/plan/                  | Write plan checkpoint JSON from graph state                                                                                                |
| `checkpoint.ts` (schema)      | @assignee/core/schema/          | Checkpoint serialize/validate schema (Zod)                                                                                                 |
| `cleanup.ts`                  | services/                       | Orchestrates checkpoint/cache/memory cleanup                                                                                               |
| `price-cache.ts`              | services/                       | TTL-based pricing result cache                                                                                                             |
| `mcp-client.ts`               | services/                       | MCP server process management (singleton)                                                                                                  |
| `list-resources.ts`           | services/                       | AWS Resource Groups Tagging API queries                                                                                                    |
| `billing.ts`                  | services/                       | Live cost data from Cost Management MCP                                                                                                    |
| `drift-detector.ts`           | services/                       | Deep-diff desired vs. actual state                                                                                                         |
| `drift-detector-factory.ts`   | services/                       | Factory for drift detector with env config                                                                                                 |
| `destroy-service.ts`          | services/                       | Single-resource destroy logic (production bulk destroy removed Story 50-3; tier ordering lives in `packages/core/src/destroy-strategies/`) |
| `resource-resolver.ts`        | services/                       | Resolve resources by ARN or name                                                                                                           |
| `status-aggregator.ts`        | services/                       | Aggregate resources for status command                                                                                                     |
| `cloudcontrol-client.ts`      | services/                       | CloudControl SDK client factory                                                                                                            |
| `cloudcontrol-adapter.ts`     | services/                       | ProvisioningPort implementation                                                                                                            |
| `credential-detector.ts`      | services/                       | AWS credential auto-detection                                                                                                              |
| `completion-generator.ts`     | services/                       | Shell completion generation                                                                                                                |
| `desired-state-sanitizer.ts`  | packages/core/src/services/     | Strip extraneous keys, coerce types                                                                                                        |
| `required-field-repairer.ts`  | services/                       | Fill missing required fields from defaults                                                                                                 |
| `s3-upload.ts`                | services/                       | Static site file upload to S3                                                                                                              |
| `audit/`                      | packages/core/src/audit/        | HMAC-chain audit log — `audit-log.ts`, `audit-verifier.ts`, `hmac-chain.ts`                                                                |
| `rbac/`                       | packages/core/src/rbac/         | RBAC scaffolding — `policy-schema.ts`, `policy-store.ts`, `role-context.ts`; five fixtures (admin/operator/read-only/auditor/restricted)   |
| `provisioning/`               | packages/core/src/provisioning/ | Partition-aware provisioner router — `ccapi-partition-support.ts` matrix + `partition-aware-provisioner.ts`                                |
| `telemetry/spans.ts`          | packages/core/src/telemetry/    | Per-graph-node span emitter (13/14 nodes at entry + exit; HUMAN_APPROVAL excluded)                                                         |
| `telemetry/otel-allowlist.ts` | packages/core/src/telemetry/    | `OTEL_FIELD_ALLOWLIST` + `FIELD_PRIVACY_MAP` source-side allowlist with `@privacy: PII/SYSTEM/OPERATIONAL` classification                  |

## Persistence Boundaries and Sensitive-Field Redaction

Three redaction layers compose additively at every persistence boundary (pattern-memory writes, checkpoint writes, OTEL emission, failure-record `errorMessage`):

1. **`ResourceField.sensitive?: boolean`** (`packages/core/src/resource-plugins/`) — plugin authors mark fields whose values must never leave the machine (e.g., `MasterUserPassword`, `SecretString`, `AuthParameters`). `stripSensitiveFromElicited()` in `packages/core/src/utils/redact.ts` enforces this at every write site.
2. **CFN property-name allowlist** (`packages/core/src/checkpoint/redaction.ts`) — CloudFormation property names known to carry secret values are allowlisted for scrubbing. Uses allowlist-not-denylist semantics to avoid false-positive matches on benign fields like `PasswordPolicy`, `UserData`, and `TokenValidityUnits`.
3. **OTEL field allowlist** (`packages/core/src/telemetry/otel-allowlist.ts`) — `OTEL_FIELD_ALLOWLIST` with `@privacy: PII | SYSTEM | OPERATIONAL` classification. Unknown fields are dropped before forwarding to any OTEL exporter.

All three layers run in this order before any data reaches disk, an external sink, or an LLM prompt.

## Audit Log

`packages/core/src/audit/` provides an HMAC chain-of-custody log:

- **Chain primitive** (`hmac-chain.ts`): `HMAC(key, prevHmac || record_serialised)`. Each record is chained to its predecessor so tampering is detectable.
- **Verifier** (`audit-verifier.ts`): Walks the chain and reports the first-broken index with `reason: payload-mismatch | hmac-mismatch | missing-prev`.
- **Key** (`ASSIGNEE_AUDIT_KEY` env var): Per-tenant when set; per-process fallback with a `WARNING` log when absent.
- **RBAC context**: Hardcoded `"operator"` role is embedded in every audit record; real per-user roles are wired in Epic 101 once OIDC enforcement lands.
- **Future sinks**: KMS-signed remote sink + S3 object-lock storage are deferred to Epic 101.

## RBAC Scaffolding

`packages/core/src/rbac/` is a scaffolded RBAC layer — not yet enforced at command boundaries:

- `policy-schema.ts` — Zod schema for role-permission policies.
- `policy-store.ts` — In-memory and file-backed adapters for storing policies.
- `role-context.ts` — Current-role resolution.
- Five fixture policies committed under `packages/core/src/rbac/__fixtures__/`: `admin`, `operator`, `read-only`, `auditor`, `restricted`.

Enforcement at CLI command boundaries is deferred to Epic 101 (OIDC + real role resolution).

## Partition-Aware Provisioning

`packages/core/src/provisioning/` adds a routing layer for non-commercial AWS partitions:

- `ccapi-partition-support.ts` — Matrix of which resource types are available in GovCloud, China, ISO, and iso-e partitions.
- `partition-aware-provisioner.ts` — Routes S3, IAM, and VPC through SDK-direct adapters for non-commercial partitions; sends an actionable "not supported in `<partition>`" message for unsupported types.

This layer sits between `CloudControlAdapter` and the caller — no change to node code is required.

## Configuration System

### 6-Level Precedence (`utils/merge-configs.ts`)

Highest to lowest priority:

1. **Org locked** -- Overrides everything, including CLI flags
2. **Org always_ask** -- Forces interactive prompt regardless
3. **CLI flags** -- `--set key=value`
4. **Env overrides** -- `ASSIGNEE_*` environment variables
5. **Project config** -- `.assignee/config.yaml`
6. **User config** -- `~/.config/assignee/config.yaml`
7. **Org default** -- Remote org policy
8. **Plugin default** -- `ResourceField.question.initialValue`

### Config Loaders

| Loader                     | Source                           |
| -------------------------- | -------------------------------- |
| `user-config-loader.ts`    | `~/.config/assignee/config.yaml` |
| `project-config-loader.ts` | `.assignee/config.yaml`          |
| `org-policy-loader.ts`     | Remote org policy endpoint       |
| `org-policy-cache.ts`      | Cached org policy                |
| `env-overrides.ts`         | `ASSIGNEE_*` env vars            |
| `operator-credentials.ts`  | AWS credential resolution        |

### Config Schema (`packages/core/src/config/config-schema.ts`)

Defines `AssigneeConfig` with sections:

- `aws`: region, profile
- `defaults`: resource-type-specific default values
- `preferences`: auto_fix mode, bp_enforcement, naming conventions
- `naming`: prefix, suffix, environment

## AWS SDK Integration

- **CloudControl API**: Primary provisioning path (CreateResource, GetResource, GetResourceRequestStatus, DeleteResource)
- **CloudFormation Registry**: Schema fetching via DescribeType (with disk cache)
- **Resource Groups Tagging API**: Resource listing and discovery
- **EC2 SDK**: AMI resolution, instance type discovery, EIP allocation, key pair management, VPC/subnet discovery
- **IAM SDK**: Setup command creates users/policies/roles
- **STS SDK**: Account identity resolution for ARN construction
- **S3 SDK**: Static site file upload
- **Lambda SDK**: EventSourceMapping (CCAPI fallback)
- **SNS SDK**: Subscription (CCAPI fallback)
- **CloudFront SDK**: Distribution setup (post-provision)

## MCP Integration

The CLI spawns MCP servers as child processes via `@langchain/mcp-adapters`:

**Core servers (required, 2):**

- `aws-pricing-mcp-server` -- Real-time pricing queries (reader creds, us-east-1)
- `aws-documentation-mcp-server` -- Documentation references (no creds, public API)

**Optional servers (graceful degradation, 4):**

- `aws-knowledge-mcp-server` -- Remote knowledge API (opt-in via `ASSIGNEE_ENABLE_REMOTE_MCP=1`)
- `aws-iam-mcp-server` -- IAM permission simulation (auditor creds)
- `well-architected-security-mcp-server` -- Post-provision security checks (auditor creds)
- `billing-cost-management-mcp-server` -- Billing data (reader creds)

Each server receives its own credential set (reader or auditor).

## Error Handling

- Custom error hierarchy: `AssigneeError` base, with `McpError`, `BedrockError`, `LlmError`, `StateGuardError`, `UnsupportedResourceError`, `ConfigurationError`, `CheckpointError`, `ProvisioningError`, `MissingRequiredFieldsError`, `UserCancelledError`
- `ErrorHintRegistry` provides user-friendly error messages with actionable hints
- `Result<T>` tuple pattern `[Error | null, T]` for error propagation
- Graceful degradation: pricing, memory, free-tier, security checks all fail silently

## Logging

Structured JSON to stderr (`utils/logger.ts`). 40+ log action types covering the full lifecycle. Controlled by `ASSIGNEE_LOG_LEVEL` env var.

## See also

- [architecture-flows.md](architecture-flows.md) — execution flow diagrams for all commands, wizard flows, MCP integrations, and credential routing.
