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

The core computation is a **StateGraph** from `@langchain/langgraph` with 13 nodes.

### State (AgentState)

Defined in `apps/cli/src/services/graph-state.ts` as a LangGraph Annotation. Key channels:

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

Defined in `apps/cli/src/services/graph-routing.ts`:

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

37 registered plugins (35 resource-type plugins + 1 generic fallback; 2 compound-only types — `EC2::VPCGatewayAttachment`, `EC2::SubnetRouteTableAssociation` — share the generic plugin). Plugins provide:

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

1. **PricingStrategyRegistry** -- 23 strategies, one per resource type. Each provides:
   - `estimate(desiredState)` -> local fallback label
   - `getMcpConfig(desiredState)` -> MCP query parameters for live pricing
2. **PricingDecomposerRegistry** -- 23 decomposers. Each returns `PricingLineItem[]` with service codes, filters, units for multi-line cost breakdowns.

### Best Practices Engine (`packages/best-practices/`)

- 186 YAML rules organized by AWS service directory (s3/, ec2/, rds/, etc.); 185 tracked in `manifest.json` + 1 pending re-manifest
- `loader.ts` reads YAML files, validates with Zod schema
- `evaluate.ts` runs trigger checks against `EvalContext` (resourceType + desiredState + userIntent + patternId)
- Check types: equals, not_equals, exists, not_exists, contains, not_contains, regex, comparison, nested_array_check, any_of, custom
- Each finding can be: blocking (prevents apply), auto-fixable (with desiredStatePatch), interactive (with options)

## Service Layer (Hexagonal Architecture)

### Ports

| Port               | Location                                     | Purpose                   |
| ------------------ | -------------------------------------------- | ------------------------- |
| `LlmPort`          | `packages/core/src/ports/llm-port.ts`        | Abstract LLM interface    |
| `ProvisioningPort` | `apps/cli/src/services/provisioning-port.ts` | Abstract CloudControl API |

### Adapters

| Adapter                 | Implements       | Purpose                         |
| ----------------------- | ---------------- | ------------------------------- |
| `LlmAdapter`            | LlmPort          | Universal LLM via Vercel AI SDK |
| `BedrockLlmAdapter`     | LlmPort          | Direct Bedrock adapter          |
| `MockLlmAdapter`        | LlmPort          | Testing adapter                 |
| `CloudControlAdapter`   | ProvisioningPort | AWS CloudControl API wrapper    |
| `SDKFallbackDispatcher` | --               | SDK calls for CCAPI gap types   |

### Key Services

| Service                      | File      | Purpose                                      |
| ---------------------------- | --------- | -------------------------------------------- |
| `graph.ts`                   | services/ | LangGraph workflow construction              |
| `graph-state.ts`             | services/ | State annotation definition                  |
| `graph-routing.ts`           | services/ | Conditional edge routing                     |
| `memory.ts`                  | services/ | JSON-file provision/failure/pattern memory   |
| `checkpoint.ts`              | services/ | Plan checkpoint save/load/prune              |
| `cleanup.ts`                 | services/ | Orchestrates checkpoint/cache/memory cleanup |
| `price-cache.ts`             | services/ | TTL-based pricing result cache               |
| `mcp-client.ts`              | services/ | MCP server process management (singleton)    |
| `list-resources.ts`          | services/ | AWS Resource Groups Tagging API queries      |
| `billing.ts`                 | services/ | Live cost data from Cost Management MCP      |
| `drift-detector.ts`          | services/ | Deep-diff desired vs. actual state           |
| `drift-detector-factory.ts`  | services/ | Factory for drift detector with env config   |
| `destroy-service.ts`         | services/ | Single-resource destroy logic                |
| `bulk-destroy.ts`            | services/ | Tier-ordered bulk destroy                    |
| `resource-resolver.ts`       | services/ | Resolve resources by ARN or name             |
| `status-aggregator.ts`       | services/ | Aggregate resources for status command       |
| `cloudcontrol-client.ts`     | services/ | CloudControl SDK client factory              |
| `cloudcontrol-adapter.ts`    | services/ | ProvisioningPort implementation              |
| `sdk-fallback-dispatcher.ts` | services/ | SDK fallback for CCAPI gaps                  |
| `credential-detector.ts`     | services/ | AWS credential auto-detection                |
| `completion-generator.ts`    | services/ | Shell completion generation                  |
| `desired-state-sanitizer.ts` | services/ | Strip extraneous keys, coerce types          |
| `required-field-repairer.ts` | services/ | Fill missing required fields from defaults   |
| `s3-upload.ts`               | services/ | Static site file upload to S3                |

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
- `aws-cost-management-mcp-server` -- Billing data (reader creds)

Each server receives its own credential set (reader or auditor).

## Error Handling

- Custom error hierarchy: `AssigneeError` base, with `McpError`, `BedrockError`, `LlmError`, `StateGuardError`, `UnsupportedResourceError`, `ConfigurationError`, `CheckpointError`, `ProvisioningError`, `MissingRequiredFieldsError`, `UserCancelledError`
- `ErrorHintRegistry` provides user-friendly error messages with actionable hints
- `Result<T>` tuple pattern `[Error | null, T]` for error propagation
- Graceful degradation: pricing, memory, free-tier, security checks all fail silently

## Logging

Structured JSON to stderr (`utils/logger.ts`). 40+ log action types covering the full lifecycle. Controlled by `ASSIGNEE_LOG_LEVEL` env var.
