# @assignee/core

Shared types, schemas, ports, and registries used by both the [`assignee` CLI](../../apps/cli/README.md) and the [`@assignee/mcp-server`](../../apps/mcp-server/README.md).

## What this package is

`@assignee/core` is the framework-agnostic core of Assignee.ai. It contains everything that must stay identical between the CLI and the MCP server: Zod schemas for the LangGraph state, the resource plugin registry, the pattern template registry, the pricing strategy registry, error classes, and centralized AWS credential resolution.

## Architectural role

This package has zero dependencies on `commander`, `@clack/prompts`, LangGraph, or any AWS client beyond `@aws-sdk/client-cloudformation` (used by the schema service). That keeps it embeddable from any host — CLI, MCP server, or future SaaS workers — without dragging in a UI layer.

If a piece of logic is needed in more than one app, it belongs here.

## Public API (selected)

Exported from `src/index.ts`:

- **Graph & checkpoint schemas** — `GraphStateSchema`, `PlanCheckpointSchema`, `CHECKPOINT_VERSION`, `ExecutionMode`, `PreflightMode`, `BPEnforcementLevel`.
- **Plan & result types** — `PlanSchema`, `Plan`, `Result`, `safeTry`.
- **Drift detection types** — `DriftStatus`, `DriftResult`, `DriftedField`, `AUTO_POPULATED_FIELDS`.
- **Resource plugins** — `defaultPluginRegistry`, `PluginRegistry`, `collectCompanionResources`, plus the `ResourcePlugin` / `ResourceField` / `FieldQuestion` types that every resource type implements.
- **Pattern templates** — `defaultPatternRegistry`, `PatternRegistry`, `PatternId`, `ArchitecturePattern`.
- **Pricing** — `defaultPricingRegistry`, `defaultDecomposerRegistry`, `PricingStrategyRegistry`, `PricingDecomposerRegistry`, `extractFirstTierPrice`, plus pricing types and enums (`PricingKind`, `PricingServiceCode`, `PricingProductFamily`, ...).
- **Config schema** — `AssigneeConfig`, `validateConfig`, `CONFIG_DEFAULTS`, `AutoFixMode`.
- **AWS credentials** — `requireAssigneeCredentials`, `tryAssigneeCredentials`, `ASSIGNEE_ROLES`, `MissingAssigneeCredentialsError`. The single source of truth for resolving operator/reader/auditor IAM identities.
- **IAM helpers** — `getRequiredIamActions`, `operatorPolicy`, `readerPolicy`, `auditorPolicy`.
- **CloudFormation schema service** — `CloudFormationSchemaService`, `SchemaCacheWarmer`, `adaptDescribeTypeToMcpFormat`.
- **Errors** — `AssigneeError` and its subclasses (`McpError`, `LlmError`, `StateGuardError`, `ProvisioningError`, `MissingRequiredFieldsError`, `UserCancelledError`, ...) plus `defaultErrorHintRegistry`.
- **Ports (hexagonal)** — `LlmPort`.
- **Constants** — `CfnKey`, `ResourceDefault`, `AwsDefault`, `AssigneeTag`, `RESOURCE_TYPES`, `SUPPORTED_TYPES_ARRAY`, `ASSIGNEE_DIR`, ...

See `src/index.ts` for the full export surface.

### Sub-path exports

Some helpers ship behind dedicated sub-paths so production code never accidentally imports test-only utilities:

- **`@assignee/core/testing`** — `MockLlmAdapter` (test-only LLM port stub used by unit/integration tests). Never import from production code.

## Developing

From the repo root:

```bash
pnpm install
pnpm --filter @assignee/core build
pnpm --filter @assignee/core test
pnpm --filter @assignee/core check-types
```

The full CI gate is `pnpm build && pnpm test` from the repo root.

## Where to read more

- [docs/architecture.md](../../docs/architecture.md) — how core is wired into the LangGraph pipeline
- [docs/resource-types.md](../../docs/resource-types.md) — supported AWS resource types and their plugin contracts
- [docs/configuration.md](../../docs/configuration.md) — `AssigneeConfig` schema reference
