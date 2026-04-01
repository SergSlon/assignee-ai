# Epic 40 — Full Resource Coverage: Cost Estimator Keywords, Free Tier, and Pricing Strategy Gap

## Problem Statement

Three subsystems have partial resource type coverage, meaning some of the 23 supported types are invisible to cost estimation, free tier awareness, or pricing queries:

| System                                                                     | Current | Target | Gap                                                                    |
| -------------------------------------------------------------------------- | ------- | ------ | ---------------------------------------------------------------------- |
| Cost Estimator Keywords (`apps/mcp-server/src/services/cost-estimator.ts`) | 14/23   | 23/23  | 9 types have no NL keyword mappings                                    |
| Free Tier — MCP server (`apps/mcp-server/src/services/free-tier.ts`)       | 6/23    | 15/23  | Missing 9 always-free resources + SQS/SNS limits note missing from CLI |
| Free Tier — CLI (`apps/cli/src/utils/free-tier.ts`)                        | 6/23    | 15/23  | Missing free networking resources, SQS/SNS usage-limited               |
| Pricing Strategies (`packages/core/src/pricing/index.ts`)                  | 22/23   | 23/23  | EC2 Route has no pricing strategy                                      |

## Success Criteria

- All 23 resource types have keyword mappings in cost-estimator.ts
- All always-free resources (VPC, Subnet, SG, IGW, RouteTable, Route, ECS Cluster, IAM Role, SSM Parameter) return `always_free` from both free-tier modules
- Usage-limited resources (Lambda, SQS, SNS, DynamoDB) return `usage_limited`/`always_free` consistently in both modules
- EC2 Route gets a free pricing strategy registered
- All existing tests pass + new tests for every added mapping
- `pnpm build && pnpm -r test` clean

## Architecture Decision

- **No new files needed** — all changes are additions to existing registries/maps
- **MCP free-tier.ts and CLI free-tier.ts must stay in sync** on which types are free
- **Keyword mappings should be exhaustive** — every supported type must be reachable by NL description

---

## Stories

### Story 40.1 — Cost Estimator: Add missing keyword mappings (P0)

**File:** `apps/mcp-server/src/services/cost-estimator.ts`

Add 9 missing entries to `KEYWORD_TO_RESOURCE_TYPE`:

```typescript
{ keywords: ["subnet", "private subnet", "public subnet"], resourceType: "AWS::EC2::Subnet" },
{ keywords: ["route table", "routing table"], resourceType: "AWS::EC2::RouteTable" },
{ keywords: ["route", "network route"], resourceType: "AWS::EC2::Route" },
{ keywords: ["internet gateway", "igw"], resourceType: "AWS::EC2::InternetGateway" },
{ keywords: ["nat gateway", "nat", "network address translation"], resourceType: "AWS::EC2::NatGateway" },
{ keywords: ["cloudwatch logs", "log group", "logging"], resourceType: "AWS::Logs::LogGroup" },
{ keywords: ["api gateway", "http api", "websocket api", "rest api"], resourceType: "AWS::ApiGatewayV2::Api" },
{ keywords: ["cloudwatch alarm", "metric alarm", "monitoring alarm"], resourceType: "AWS::CloudWatch::Alarm" },
{ keywords: ["secrets manager", "secret", "credentials store"], resourceType: "AWS::SecretsManager::Secret" },
```

**Ordering matters:** "route" must come AFTER "route table" to avoid false matches. "nat gateway" before generic "nat". "security group" before generic "security".

**Test:** Create `apps/mcp-server/src/services/__tests__/cost-estimator.test.ts` testing `classifyResourceType()` for all 23 types + edge cases (mixed case, partial matches, no match returns null).

**AC:**

- All 23 resource types are reachable via at least one keyword
- No keyword collisions (e.g., "route" should not match RouteTable)
- `classifyResourceType("create a NAT gateway")` returns `AWS::EC2::NatGateway`
- `classifyResourceType("set up CloudWatch alarm")` returns `AWS::CloudWatch::Alarm`

---

### Story 40.2 — Free Tier MCP: Add all free resources (P0)

**File:** `apps/mcp-server/src/services/free-tier.ts`

Add missing always-free resources to `ALWAYS_FREE`:

```typescript
"AWS::EC2::VPC": "Always free tier",
"AWS::EC2::Subnet": "Always free tier",
"AWS::EC2::SecurityGroup": "Always free tier",
"AWS::EC2::InternetGateway": "Always free tier",
"AWS::EC2::RouteTable": "Always free tier",
"AWS::EC2::Route": "Always free tier",
"AWS::ECS::Cluster": "Always free tier (compute charged separately via tasks)",
```

Update `ALWAYS_FREE_WITH_LIMITS` — add DynamoDB (it's in ALWAYS_FREE currently but has usage limits, should be consistent):

Verify final state:

- `ALWAYS_FREE`: IAM Role, SSM Parameter, VPC, Subnet, SecurityGroup, IGW, RouteTable, Route, ECS Cluster (9 types)
- `ALWAYS_FREE_WITH_LIMITS`: Lambda, SQS, SNS, DynamoDB (4 types)
- Total: 13/23 types return free tier info

**Test:** Create `apps/mcp-server/src/services/__tests__/free-tier.test.ts` testing all resource types.

**AC:**

- `getFreeTierNote("AWS::EC2::VPC")` returns `{ type: "always_free", message: "Always free tier" }`
- `getFreeTierNote("AWS::EC2::NatGateway")` returns `null` (not free)
- All 13 free resources return non-null

---

### Story 40.3 — Free Tier CLI: Add all free resources (P0)

**File:** `apps/cli/src/utils/free-tier.ts`

Add missing always-free resources to `ALWAYS_FREE_RESOURCES`:

```typescript
[RESOURCE_TYPES.EC2_VPC]: "Always free tier",
[RESOURCE_TYPES.EC2_SUBNET]: "Always free tier",
[RESOURCE_TYPES.EC2_SECURITY_GROUP]: "Always free tier",
[RESOURCE_TYPES.EC2_INTERNET_GATEWAY]: "Always free tier",
[RESOURCE_TYPES.EC2_ROUTE_TABLE]: "Always free tier",
[RESOURCE_TYPES.EC2_ROUTE]: "Always free tier",
[RESOURCE_TYPES.ECS_CLUSTER]: "Always free tier (compute charged separately via tasks)",
```

Add SQS and SNS to `ALWAYS_FREE_WITH_LIMITS` (currently only Lambda is there, but MCP version has SQS/SNS — they should be consistent):

```typescript
[RESOURCE_TYPES.SQS_QUEUE]: "1M requests/month",
[RESOURCE_TYPES.SNS_TOPIC]: "1M publishes/month",
```

**Test:** Update `apps/cli/src/utils/free-tier.test.ts` — add test cases for all new resources.

**AC:**

- CLI and MCP free tier modules agree on which resources are free
- All 7 new always-free resources return `always_free` type
- SQS/SNS return `always_free` with usage limits note
- Existing tests still pass (IAM, SSM, DynamoDB, Lambda, EC2, RDS)

---

### Story 40.4 — EC2 Route Pricing Strategy (P2)

**File:** `packages/core/src/pricing/index.ts` + new `packages/core/src/pricing/strategies/route.ts`

EC2 Route is the only supported type without a pricing strategy. Routes are free.

Create `strategies/route.ts` following the same pattern as `strategies/vpc.ts`:

```typescript
export const routePricingStrategy: PricingStrategy = {
  estimateLocal(): PricingEstimate {
    return { perMonth: null, label: "No charge", isFree: true };
  },
};
```

Register in `index.ts`:

```typescript
import { routePricingStrategy } from "./strategies/route.js";
defaultPricingRegistry.register(RESOURCE_TYPES.EC2_ROUTE, routePricingStrategy);
```

**AC:**

- `defaultPricingRegistry.estimate("AWS::EC2::Route")` returns `{ isFree: true }`
- 23/23 pricing strategies registered

---

### Story 40.5 — Integration test: full coverage verification (P1)

**File:** New test `packages/core/src/pricing/decomposers/coverage.test.ts`

Write a single integration test that:

1. Imports `SUPPORTED_TYPES_ARRAY` from resource-types
2. Imports `defaultPricingRegistry` and `defaultDecomposerRegistry` from pricing/index
3. For every type in `SUPPORTED_TYPES_ARRAY`, asserts:
   - `defaultPricingRegistry.has(type)` is true (pricing strategy registered)
   - `defaultDecomposerRegistry.has(type)` is true (decomposer registered)
4. Asserts the total count equals 23

This test will catch any future regressions when new resource types are added.

**AC:**

- Test passes with 23/23 coverage on both registries
- Any new resource type added to `SUPPORTED_TYPES_ARRAY` will fail this test until a strategy + decomposer are added

---

### Story 40.6 — Cross-system consistency test (P1)

**File:** New test `apps/mcp-server/src/services/__tests__/coverage-consistency.test.ts`

Write a test that:

1. Imports `SUPPORTED_TYPES_ARRAY` from @assignee/core
2. For every type, calls `classifyResourceType()` with the type name (lowercased, stripped of "AWS::") and verifies it returns a non-null match OR is tested with a known keyword
3. Verifies that every always-free resource in the pricing strategy (where `isFree === true`) is also in the free-tier maps

This prevents the systems from drifting apart as new types are added.

**AC:**

- All 23 types are reachable via keyword classification
- Free tier maps are consistent between MCP and CLI modules
- Pricing strategy `isFree` status matches free-tier module classifications

---

## Implementation Order

1. **Story 40.4** (EC2 Route strategy) — smallest, unblocks coverage test
2. **Story 40.1** (Cost estimator keywords) — highest user impact
3. **Stories 40.2 + 40.3** (Free tier MCP + CLI) — parallel, same pattern
4. **Story 40.5** (Coverage integration test) — verifies 40.4
5. **Story 40.6** (Cross-system consistency) — final validation

## Estimated Complexity

- Stories 40.1-40.3: Small (adding entries to existing maps + tests)
- Story 40.4: Trivial (one file, 10 lines)
- Stories 40.5-40.6: Small (test-only, no production code changes)

Total: ~200 lines of production code, ~400 lines of tests.

## Risks

- **Keyword collision**: "route" could match Route or RouteTable. Mitigated by ordering entries with more specific matches first.
- **Free tier drift**: CLI and MCP modules could diverge. Mitigated by Story 40.6 consistency test.
- **DynamoDB classification inconsistency**: Currently in `ALWAYS_FREE` in MCP but arguably should be `ALWAYS_FREE_WITH_LIMITS` since it has 25GB/25RCU limits. Story 40.2 addresses this.
