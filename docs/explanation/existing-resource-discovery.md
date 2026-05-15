# Existing-Resource Discovery

**EPIC-107-2** (PH1-G-2 deep fix) — closes the deferral from Epic-105.

## What is it?

At intent-parse time, `assignee plan` calls the AWS API (via reader
credentials) to enumerate resources that already exist in the user's account —
VPCs, RDS DB subnet groups, ECS clusters, and ALB/NLB load balancers. Matched
resources appear in the plan output before the Desired-resources block:

```
Found existing VPC: vpc-abc123 (us-east-1)
Found existing EcsCluster: my-cluster (us-east-1)
```

These are **Existing nodes** — read-only snapshots of real infrastructure.
They are distinct from **Desired nodes**, which represent resources assignee
will provision.

## Destroy isolation invariant (CRITICAL)

**`Existing` nodes are NEVER destroyed by `assignee destroy`.**

This is enforced structurally:

- Existing nodes live in `graph-state.existingResources` (`ExistingResource[]`).
- Destroy strategies (bulk-action and single-flow) iterate `ManagedResource[]`
  from `provisions.json` via `fetchManagedResources()`. They do NOT read
  `graph-state.existingResources`.
- `ExistingResource` has no `resourceArn` or `provisionedAt` fields —
  the type boundary prevents accidental misuse as a `ManagedResource`.

Test: `existing-resource-extractor.test.ts` Variation F explicitly asserts this
boundary at the type level.

## Architecture (ADR 2026-05-15, Winston)

**Option D: extend the existing direct-SDK `aws-resource-discovery` module.**

The existing module (`packages/core/src/utils/aws-resource-discovery/`) already
covers EFS, EC2 network, RDS, Lambda, SNS, KMS, AMI discovery with:

- Reader-cred isolation (`tryAssigneeCredentials("reader")`)
- Per-fetcher TTL caching via `cachedDiscover()` (default 300 s)
- Graceful no-op when reader credentials are absent
- Timeout enforcement (`DISCOVERY_TIMEOUT_MS = 6000`)
- A battle-tested `vi.mock` test pattern across 5+ test files

**Rejected alternatives:**

- IAM MCP — covers only IAM users/roles/groups, wrong surface for VPC/RDS/ECS.
- Well-Architected Security MCP — compliance-shaped, not intent-time pinning.
- New ResourceExplorer MCP — requires service-side setup (aggregator-region) the
  CLI cannot impose; adds subprocess-credential fragility.

## Port boundary

`ResourceDiscoveryPort` (`packages/core/src/services/resource-discovery-port.ts`)
is the hexagonal-architecture boundary:

```ts
export interface ResourceDiscoveryPort {
  discoverVpcs(opts: { region?: string }): Promise<ExistingResource[]>;
  discoverSubnetGroups(opts: { region?: string }): Promise<ExistingResource[]>;
  discoverEcsClusters(opts: { region?: string }): Promise<ExistingResource[]>;
  discoverElbs(opts: { region?: string }): Promise<ExistingResource[]>;
}
```

Production impl wraps the existing module. Test impl uses `vi.mock`. CI passes
with empty AWS env vars — no real AWS calls in tests.

## New SDK helpers

| File                   | AWS API                                           | Cache key          |
| ---------------------- | ------------------------------------------------- | ------------------ |
| `vpc.ts`               | `DescribeVpcsCommand`                             | `VPCS`             |
| `rds-subnet-groups.ts` | `DescribeDBSubnetGroupsCommand`                   | `DB_SUBNET_GROUPS` |
| `ecs.ts`               | `ListClustersCommand` + `DescribeClustersCommand` | `ECS_CLUSTERS`     |
| `elb.ts`               | `DescribeLoadBalancersCommand`                    | `ELBS`             |

## Multi-match elicitation

When multiple resources match the intent (e.g. two VPCs):

1. **Tag-substring fast-path** (high-confidence auto-select): we tokenize the
   intent into words ≥ 4 chars, drop stopwords (kind names like `vpc`, `alb`,
   `rds`; articles like `the`, `my`; helpers like `with`, `for`), and check
   whether multiple words uniquely identify the SAME candidate. Only then do
   we auto-select.
2. **Ambiguous fall-through** (no picker yet wired): when no high-confidence
   match exists, the extractor (a) DROPS all candidates from `existing[]`
   so graph state isn't polluted with N "Found existing" lines, (b) reports
   the kind via `ambiguous[]`, and (c) the intent-parser emits a non-blocking
   advisory `EXISTING_RESOURCE_AMBIGUOUS` naming the kinds + candidate counts.
   The user is invited to rephrase with a distinguishing name fragment.
3. **Picker (deferred)**: the option-elicitor picker is the proper surface for
   the ambiguous case per the ADR but is not wired in this story. The
   advisory + `ambiguous[]` carry enough structured data for a follow-up
   story to wire the picker without re-running discovery.

## Failure handling

If discovery fails (missing reader creds, network timeout, AWS error):

- The error is logged once with
  `callsite: "intent-parser/existing-resource-extractor"`.
- The extractor returns `[]` — no exception propagates.
- The CP-3 advisory path (vpc-default-hint-extractor) renders unchanged.
- The plan does NOT crash.

## Cost and latency

- Discovery adds at most 4 parallel AWS API calls at plan time.
- Each call is bounded by `DISCOVERY_TIMEOUT_MS` (6 s).
- Cache TTL is 300 s (default) — repeated `assignee plan` calls within 5 min
  hit the in-process cache, zero extra AWS calls.
- Cache entries are keyed by resource kind, not by region (single-account,
  single-region scope).

## Out of scope

- Drift detection (comparing Existing state to expected) — separate epic.
- Mutation of Existing resources — read-only; `assignee` never modifies them.
- Cross-account discovery — single-account, single-region only.
- Auto-import to `provisions.json` — blast radius too high; separate ticket.
