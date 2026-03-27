# Mock Fidelity Audit: Pricing Tool Mocks

**Date:** 2026-03-27
**Auditor:** Automated audit of `createMockTool(ToolName.GET_PRICING, ...)` and `createPricingMockTools()` usage

## Summary

The `createMockTool()` factory returns a **static mock** that ignores input arguments and always returns the same response. When used for pricing, this means the mock returns the same pricing data regardless of what `service_code` or `filters` the code sends. This is dangerous for tests that validate pricing behavior because filter-dispatch bugs are invisible.

**Files audited:** 4 test files use pricing mocks
**Issues found:** 3 high-impact, 2 low-impact
**Fixed:** 3 (S3 happy path, EC2 happy path + breakdown, RDS happy path)

## Audit Results

| Test File | Mock Used | Resource Tested | Adequate? | Risk | Action |
|---|---|---|---|---|---|
| `graph-integration.test.ts` L228 | ~~`createPricingMockTools(s3Storage)`~~ | S3 Bucket | **FIXED** | HIGH | Replaced with `createS3PricingDispatchTool()` |
| `graph-integration.test.ts` L316 | ~~`createPricingMockTools(ec2T3Micro)`~~ | EC2 Instance | **FIXED** | HIGH | Replaced with `createEc2PricingDispatchTool()` |
| `graph-integration.test.ts` L403 | ~~`createPricingMockTools(rdsT3MicroPostgres)`~~ | RDS DBInstance | **FIXED** | HIGH | Replaced with `createRdsPricingDispatchTool()` |
| `graph-integration.test.ts` L724 | ~~`createPricingMockTools(ec2T3Micro)`~~ | EC2 pricingBreakdown | **FIXED** | HIGH | Replaced with `createEc2PricingDispatchTool()` |
| `graph-integration.test.ts` L285 | `createPricingMockTools(emptyData)` | Lambda (missing field) | OK | NONE | Lambda uses local estimate, empty is correct |
| `graph-integration.test.ts` L338 | `createPricingMockTools(emptyData)` | Lambda (local pricing) | OK | NONE | Lambda skips MCP pricing, empty is correct |
| `graph-integration.test.ts` L368 | `createMockTool(GET_PRICING, zeroPrice)` | IAM Role | OK | NONE | IAM is free-tier, tool should NOT be called |
| `graph-integration.test.ts` L604 | `createMockTool(GET_PRICING, null)` | S3 (timeout) | OK | NONE | Tests timeout fallback, null is intentional |
| `graph-integration.test.ts` L648 | `createMockTool(GET_PRICING, malformedJson)` | S3 (malformed) | OK | NONE | Tests malformed response handling |
| `graph-integration.test.ts` L700 | `createPricingMockTools(s3Storage)` | S3 (fix_applicator) | OK | LOW | Not testing pricing, just fix_applicator flow |
| `graph-integration.test.ts` L748+ | `createPricingMockTools(emptyData)` | DynamoDB/SG/VPC/etc. | OK | NONE | Free-tier resources, empty pricing correct |
| `preflight-guard.test.ts` L215 | Inline real MCP response | S3 | OK | NONE | Uses realistic inline response |
| `preflight-guard.test.ts` L79+ | Inline vi.fn() mock | IAM/Lambda | OK | NONE | Tests free-tier and local estimate paths |
| `billing.test.ts` L174 | `createMockTool(GET_PRICING, s3Storage)` | S3 (billing) | OK | NONE | Tests tool-type detection, not pricing data |
| `mcp-mock-responses.test.ts` | `createServicePricingDispatchTool` | N/A (unit tests) | OK | NONE | Tests the dispatch factory itself |

## Top 5 Recommendations (by impact)

### 1. DONE -- EC2 pricingBreakdown test (HIGHEST IMPACT)

The EC2 decomposer issues 3+ separate MCP calls with different `productFamily` filters (Compute Instance, Storage, Data Transfer). The static mock returned the **same EC2 compute hourly price** for ALL calls, meaning the breakdown showed compute pricing for EBS storage and data transfer. This could mask bugs where:
- EBS storage filter construction is wrong
- Data transfer filter uses wrong `fromLocationType`
- The decomposer fails to set `serviceCode` correctly for cross-service queries

**Fix applied:** Replaced with `createEc2PricingDispatchTool()`.

### 2. DONE -- S3 happy path (HIGH IMPACT)

The S3 test validates `estimatedMonthlyCost` matches `$0.0230` and checks `service_code: "AmazonS3"`, but a static mock would return this even if the S3 pricing strategy sent wrong `productFamily` or `usagetype` filters. The S3 decomposer also runs 4 separate queries.

**Fix applied:** Replaced with `createS3PricingDispatchTool()`.

### 3. DONE -- RDS happy path (HIGH IMPACT)

RDS decomposer issues 3 calls (compute, storage, backup) with different `productFamily` filters. The static mock returned compute pricing for all three. No cost assertion existed, but the pricingBreakdown would be incorrect.

**Fix applied:** Replaced with `createRdsPricingDispatchTool()`.

### 4. Consider adding cost assertions to EC2 and RDS tests

The EC2 and RDS happy path tests check `executionStatus` and `desiredState` but do NOT assert on `estimatedMonthlyCost`. With dispatch mocks now in place, these tests could validate that the headline cost reflects the correct compute price.

### 5. Consider dispatch mocks for the `createAllMockTools()` factory

`createAllMockTools()` always returns S3 storage pricing for GET_PRICING. It is used in 2 failure-path tests (unsupported resource, LLM failure) where pricing is irrelevant, so this is LOW risk. If it were used in happy-path tests for non-S3 resources, it would be dangerous.

## New Factories Added

Two new dispatch tool factories were added to `apps/cli/src/test-fixtures/mcp-mock-responses.ts`:

- **`createEc2PricingDispatchTool(instanceType?, instanceMock?)`** -- dispatches by `productFamily` to return correct prices for Compute Instance, EBS Storage, Public IPv4, and Data Transfer
- **`createRdsPricingDispatchTool(computeMock?)`** -- dispatches by `productFamily` to return correct prices for Database Instance, Database Storage, and Storage Snapshot (backup)

These join the existing `createS3PricingDispatchTool()` and `createServicePricingDispatchTool()`.
