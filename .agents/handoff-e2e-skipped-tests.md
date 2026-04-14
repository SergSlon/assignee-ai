# E2E Skipped Tests — DONE ✅

## Final Result (2026-04-14)

**All 3 E2E tests PASSING in live AWS:**

| Test              | Resources                                | Duration | Status  |
| ----------------- | ---------------------------------------- | -------- | ------- |
| container-service | 15 (VPC + ECR + ECS + ALB)               | 526s     | ✅ PASS |
| static-website    | 4 (S3 + OAC + CloudFront + BucketPolicy) | 773s     | ✅ PASS |
| three-tier-web    | 22 (full VPC + ALB + EC2 + RDS)          | 1298s    | ✅ PASS |

**E2E score: 31 pass / 0 fail / 0 skip** (was 28/0/3)
**Unit tests: 3526 pass**

## Session stats

- 25 commits from 08c4cd0 to HEAD
- Fixed 20+ distinct bugs in compound provisioning + destroy
- Added new infrastructure: DBSubnetGroup plugin, markerRegion(), CloudFront retry path, ALB ENI drain

## Key fixes

### Root causes

- **ALB CCAPI deleteResource needed FULL ARN** (not extractIdentifier output) — was silently skipping deletes as NOT_FOUND
- **VPCSecurityGroups** (not VpcSecurityGroupIds) — CCAPI uses CFN schema, not SDK key
- **HttpTokens nested in MetadataOptions** — top-level rejected by CCAPI
- **AMI resolution for compound EC2** — was only in non-compound path
- **CloudFront poll timeout** 5m→20m — deployments take 10-15 min
- **DESTROY_MAX_POLL_ATTEMPTS** 60→600 — RDS delete takes 5-15 min
- **Embedded marker resolution** — was only handling full-string markers
- **BP compound suppressions** for IGW/Route rules on new patterns
- **ECS Cluster bare-identifier ARN synthesis**
- **recursionLimit** 500→1000 for 22-resource compounds

### New infrastructure

- `AWS::RDS::DBSubnetGroup` plugin + pricing strategy
- `markerRegion()` marker token
- CloudFront S3 retry logic (status-poller → resource-provisioner loop)
- ALB ENI drain polling in destroy-service
- Tier-boundary waits in E2E destroyAndAssert
- afterAll cleanup blocks for all 3 compound tests (scoped by run)

## IAM policy update applied

Added to operator user: `rds:CreateDBSubnetGroup`, `rds:DeleteDBSubnetGroup`, `rds:DescribeDBSubnetGroups`, `rds:ModifyDBSubnetGroup`, `rds:CreateDBSnapshot`, `rds:DeleteDBSnapshot`, `rds:DescribeDBSnapshots`, `rds:CopyDBSnapshot`.

`iam-actions.ts` updated so future `assignee setup` runs include these automatically.

## Next steps

1. `git push` — 25 commits ready to push to remote
2. Update `_bmad-output/implementation-artifacts/sprint-status.yaml` — mark 3 skipped E2E tests as resolved
3. Next story: Epic 47 stories ready-for-dev (47-2 plan-only coverage, 47-3 free-tier apply-destroy, 47-5 cheap compute, 47-6 moderate cost)
