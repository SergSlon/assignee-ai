# Story E2E.6: Fix Remaining 9 E2E Failures (112/150 → 150/150)

Status: ready-for-dev

## Current State (Run 13, 2026-03-25)

112/150 PASS. Plan+Estimate: 25/25 (100%). Apply: 23/25. Destroy: 17/25.

## Remaining 9 Failures

### Apply Failures (2)

1. **Lambda-Function apply**: "The role defined for the function cannot be assumed by Lambda"
   - **Root cause**: IAM role propagation delay. The shared Lambda role is created 10s before Lambda test runs, but IAM is eventually consistent and needs ~15-20s.
   - **Fix**: Increase IAM propagation delay in E2E harness from 10s to 20s. OR add retry with exponential backoff in plan-generator for Lambda role validation.

2. **RDS-DBInstance apply**: "Resource provisioning timed out after 5 minutes"
   - **Root cause**: RDS provisioning takes 8-15 minutes. The graph's internal timeout (in resource-provisioner status-poller) is 5 minutes.
   - **Fix**: Increase status-poller timeout for RDS from 5min to 15min. Check `apps/cli/src/nodes/status-poller.ts` for the MAX_POLL_ATTEMPTS and POLL_INTERVAL constants.

### Destroy Failures (7)

3. **IAM-Role destroy**: "No managed resource found matching e2e-role-xxx"
   - **Root cause**: MCP destroy_resource resolves by ARN via Tagging API, but the apply result returns just the role name (not ARN). The E2E harness looks up the ARN from list_managed_resources but IAM roles may not appear in Tagging API immediately.
   - **Fix**: Add retry logic for Tagging API resolution in destroy_resource, or use a direct IAM delete for roles.

4. **DynamoDB-Table destroy**: "Resource cannot be deleted as it is currently protected against deletion"
   - **Root cause**: DeletionProtectionEnabled=true is set by the plugin defaults AND by the LLM despite the E2E description saying "DeletionProtectionEnabled false". The sanitizer doesn't strip it because it IS a valid schema property.
   - **Fix**: In MCP destroy flow, before calling DeleteResource for DynamoDB, call UpdateResource to set DeletionProtectionEnabled=false. OR remove DeletionProtectionEnabled from plugin defaults.

5. **SQS-Queue destroy**: Identifier format mismatch
   - **Root cause**: CloudControl QueueUrl identifier (`https://sqs...`) doesn't match what the E2E harness passes (which is the ARN from Tagging API). Need to extract QueueUrl from the ARN for CloudControl.
   - **Fix**: The `getCloudControlIdentifier` function handles SQS→QueueUrl conversion, but the E2E harness is passing the raw ARN. Verify the MCP destroy correctly converts ARN to QueueUrl.

6. **Route destroy**: Composite identifier `rtb-xxx|0.0.0.0/0`
   - **Root cause**: Route has no ARN — it uses composite primaryIdentifier [RouteTableId, CidrBlock]. The Tagging API can't find Routes by ARN. The apply result returns the composite ID but destroy can't resolve it.
   - **Fix**: In destroy_resource, add special handling for Route: accept composite identifiers directly and call DeleteResource without Tagging API resolution.

7. **API-Gateway-V2 destroy**: Internal ID not matching
   - **Root cause**: The apply result returns an internal IAM role ID (from compound pattern), not the API Gateway ARN. The E2E harness passes this to destroy which can't find it.
   - **Fix**: For compound patterns, the destroy should use the ARN from list_managed_resources for each resource type, not the compound result's internal IDs.

8-9. **Compound-MessageQueue/ServerlessAPI destroy**: Same compound identifier issue as #7

## Tasks / Subtasks

- [ ] Task 1: Lambda IAM delay (AC: apply #1)
  - [ ] 1.1 In e2e-test.mjs, increase IAM propagation delay from 10s to 20s
  - [ ] 1.2 Test Lambda apply passes

- [ ] Task 2: DynamoDB DeletionProtection (AC: destroy #4)
  - [ ] 2.1 Remove DeletionProtectionEnabled from dynamodb-table.ts plugin defaults
  - [ ] 2.2 Update dynamodb-table.test.ts to match
  - [ ] 2.3 Test DynamoDB destroy passes

- [ ] Task 3: RDS timeout (AC: apply #2)
  - [ ] 3.1 In apps/cli/src/nodes/status-poller.ts, increase MAX_POLL_ATTEMPTS or POLL_INTERVAL for RDS
  - [ ] 3.2 Test RDS apply completes within 15min

- [ ] Task 4: Destroy identifier mapping (AC: destroy #3,5,6,7,8,9)
  - [ ] 4.1 In destroy-resource.ts getCloudControlIdentifier(), verify SQS ARN→QueueUrl conversion works when called with ARN
  - [ ] 4.2 Add Route composite identifier handling — accept `rtb-xxx|cidr` directly, skip Tagging API resolution
  - [ ] 4.3 Fix E2E harness: for compound patterns, use list_managed_resources ARNs per resource type instead of compound result IDs
  - [ ] 4.4 Add IAM destroy retry logic (Tagging API eventual consistency)

- [ ] Task 5: Verify all 25/25 apply + 25/25 destroy pass
  - [ ] 5.1 Run full E2E, confirm 150/150 (or document any remaining AWS-level constraints)

## Dev Notes

### Key Files

| File                                                           | Change Needed                                      |
| -------------------------------------------------------------- | -------------------------------------------------- |
| `apps/mcp-server/e2e-test.mjs`                                 | IAM delay 10→20s, compound destroy via list ARNs   |
| `packages/core/src/resource-plugins/plugins/dynamodb-table.ts` | Remove DeletionProtectionEnabled from defaults     |
| `apps/cli/src/nodes/status-poller.ts`                          | Increase timeout for RDS                           |
| `apps/mcp-server/src/tools/destroy-resource.ts`                | Route composite ID, SQS QueueUrl verify, IAM retry |

### How to Run

```bash
# Build
npx turbo build --force

# Unit tests (must all pass)
pnpm test

# E2E against real AWS
node apps/mcp-server/e2e-test.mjs 2>&1 | tee /tmp/mcp-e2e.log

# Quick single-type test
node apps/mcp-server/e2e-test.mjs --type Lambda
node apps/mcp-server/e2e-test.mjs --type RDS
```

### AWS Prerequisites

- IAM policy v18 deployed (cloudformation:\*, iam:CreateServiceLinkedRole)
- Root account via default profile (us-east-1)
- Clean stale resources before run: `aws resourcegroupstaggingapi get-resources --tag-filters Key=managed-by,Values=assignee-ai`

## Dev Agent Record

### Agent Model Used

Claude Opus 4.6

### Previous Session Summary

10 commits, 13 E2E runs, 2972 unit tests. Created: desired-state-sanitizer, required-field-repairer, updated both MCP+CLI destroy resolvers, added getCloudControlIdentifier(), fixed BP blocking in MCP mode, Route no-tag injection, NatGateway EIP auto-allocation.
