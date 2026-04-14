# QA Expert Review — commits 08c4cd0..d3504c7

## BLOCKER (missing unit tests for production code changes)

**B1. No unit tests for `markerRegion()` / embedded marker resolution**
Files: `packages/core/src/config/marker-tokens.ts:73`, `apps/cli/src/nodes/plan-generator.ts` (+63 lines from 835fa06). Load-bearing fix, zero unit coverage. No `marker-tokens.test.ts` exists.

**B2. No unit test for `isRetryableCloudFrontS3Error`**
File: `apps/cli/src/nodes/status-poller.ts`. status-poller.test.ts only adjusts the timeout test — the new error-pattern branch is untested.

**B3. No unit test for `CCAPI_TYPE_PATTERN` filter**
File: `apps/cli/src/services/bulk-destroy.ts:127,286`. No `Recovery-point` test case in bulk-destroy.test.ts. Regex regressions would silently re-introduce CCAPI typeName crashes.

**B4. RDS `DBSubnetGroup` plugin has no test file**
`packages/core/src/resource-plugins/plugins/rds-db-subnet-group.ts` exists but no co-located `.test.ts`.

## WARNING

**W1. `destroyAndAssert` tier-wait**: Comment says "Wait 30s" but code waits 60_000ms. No assertion that resources owned by THIS run actually appear in plan.resources (RGTA cache lag would silently miss).

**W2. Hardcoded resource counts**: `e2e-plan.test.ts:2545` (`>=15`), `:2932` (`>=22`). Removing a resource would silently pass under-asserted test. Use exact count + explicit types.

**W3. afterAll cleanup scoping inconsistent**:

- container-service ECS cluster cleanup matches **any** `assignee-` cluster across runs
- IAM Role cleanup matches globally — concurrent CI run interference risk
- three-tier-web RDS cleanup matches all `assignee-*` instances regardless of age

**W4. OAC scope via `staticSuffix.slice(-8)`**: `staticSuffix` is `Date.now().toString()`, NOT the runId. If OAC name doesn't contain last-8 chars of staticSuffix, the match silently never fires.

**W5. ALB ENI drain mock test order coupling**: `destroy-service.test.ts:+1664-1675`. If production adds unrelated EC2 call between polls, order assumption breaks.

**W6. `DESTROY_MAX_POLL_ATTEMPTS=600` test runs 600 iterations**: With stub regression could become 50-min test. Consider injecting the constant.

**W7. `ownedIds.has(r.identifier) || ownedIds.has(r.arn)`**: For bare-identifier types (RDS, S3), only `r.arn` branch hits. If arn-builder regresses, every E2E destroy failure for non-full-ARN types becomes invisible.

## INFO

- RDS plugin test correctly updated to `VPCSecurityGroups`
- ALB ENI drain has 4 unit tests (happy path, polling failure, no-ENIs, missing-creds) — compliant with "real data in mocks" rule
- ALB regex fix `8c658eb` has no dedicated test
- CloudFront afterAll 10-min disable poll may need 20 min to match new poll attempts

## Summary

**Net coverage gap**: 4 BLOCKERs — all fixes verified only by live AWS E2E, not unit tests. Per "tests are the floor" rule, these need unit coverage before any release/SaaS gate.
