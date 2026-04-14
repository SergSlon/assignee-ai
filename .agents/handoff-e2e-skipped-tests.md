# Handoff: E2E Skipped Tests — Final State

## Results (verified against live AWS)

- ✅ **container-service E2E** — PASSED (15/15 provision + destroy, 526s)
- ✅ **static-website E2E** — PASSED (4/4 provision + destroy, 773s)
- ⏳ **three-tier-web E2E** — Provision verified 22/22 (multiple runs). Destroy fix committed but not yet verified end-to-end due to AWS rate limits + time.

## What changed (28 commits from 08c4cd0 to HEAD)

### Pattern fixes

- container-service: embedded public-only VPC (15 resources), ECR secure defaults, ECS ClusterSettings, ALB Name auto-injection
- three-tier-web: full VPC (14 resources) + 3 SGs + DBSubnetGroup + RDS with MasterUserPassword + EC2 with MetadataOptions.HttpTokens
- static-website: markerRegion() for regional S3 endpoint + CloudFront retry logic

### New infrastructure

- `AWS::RDS::DBSubnetGroup` plugin (resource-plugins/plugins/rds-db-subnet-group.ts)
- `markerRegion()` token for compound pattern region injection
- CloudFront S3 retry path (status-poller → resource-provisioner, cap 3 retries, 30s wait)
- ALB ENI drain polling in destroy-service (DescribeNetworkInterfaces)
- Tier-boundary waits in destroyAndAssert (60s)

### Critical production fixes

- **ALB CCAPI deleteResource needed FULL ARN, not extracted identifier** — was silently skipping deletes as NOT_FOUND
- **VPCSecurityGroups** (not VpcSecurityGroupIds) — CCAPI uses CFN schema, not SDK
- **HttpTokens nested in MetadataOptions** — top-level rejected by CCAPI
- **AMI resolution for compound EC2** — was only in non-compound path
- **CloudFront poll timeout 5m→20m** — deployments take 10-15 min
- **RDS IAM needs snapshot permissions** even with SkipFinalSnapshot=true
- **Embedded marker resolution** — was only handling full-string markers
- **BP compound suppressions** for IGW/Route rules on the new patterns
- **Non-ASCII chars (em dashes) in SG descriptions** — EC2 rejects them
- **ECS Cluster bare-identifier ARN synthesis**
- **recursionLimit 500→1000** for compound patterns

### Test infrastructure

- afterAll cleanup blocks for all 3 compound tests (IAM roles, RT disassociation, RDS polling, CloudFront disable+delete)
- destroyAndAssert with tier-boundary wait + ownedIds check for both r.identifier and r.arn
- Scoped afterAll cleanup to only THIS run's resources (scoped by staticSuffix, csSuffix, recent CreatedTime)

## IAM policy update required for three-tier-web

The assignee-operator user needs these permissions (already added via put-user-policy):

```
rds:CreateDBSubnetGroup, rds:DeleteDBSubnetGroup, rds:DescribeDBSubnetGroups,
rds:ModifyDBSubnetGroup, rds:CreateDBSnapshot, rds:DeleteDBSnapshot,
rds:DescribeDBSnapshots, rds:CopyDBSnapshot
```

`iam-actions.ts` has been updated so `assignee setup` will include these automatically for future installs.

## Remaining work

1. **Verify three-tier-web destroy** — run `RUN_E2E=1 pnpm vitest run src/e2e/e2e-plan.test.ts -t "three-tier-web"` single test (NOT the 3-test regex which causes duplicate runs). Expected: 22 provision + destroy all pass.
2. **Update sprint-status.yaml** — mark the 3 skipped tests as resolved.
3. **Move to next story** — Epic 47 stories are ready-for-dev: 47-2 (plan-only coverage), 47-3 (free-tier apply-destroy), 47-5 (cheap compute), 47-6 (moderate cost).

## Test runner regex gotcha

`pnpm vitest run -t "container-service|three-tier-web|static-website"` may run each test twice because vitest's `-t` flag matches against every test title containing the regex. Always run single tests: `-t "three-tier-web"`.

## Continuation prompt

```
Read .agents/agent-teams-bmad-guide.md and .agents/handoff-e2e-skipped-tests.md.

The 3 skipped E2E tests are now unblocked. Container-service and static-website
are verified passing in live AWS. Three-tier-web provision is verified (22/22);
destroy needs one more run with the committed RDS IAM + snapshot perms fix.

Run: RUN_E2E=1 pnpm vitest run src/e2e/e2e-plan.test.ts -t "three-tier-web"
(single test — avoid the regex trap that runs each test twice)

If three-tier-web passes, push to remote, update sprint-status.yaml, and move
to the next story per sprint-status.yaml (Epic 47 stories are ready-for-dev).
```
