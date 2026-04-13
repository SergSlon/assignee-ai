# Handoff: Fix 3 Skipped E2E Tests — Continuation Prompt

## Paste this to continue after context reset:

```
Read .agents/agent-teams-bmad-guide.md and .agents/handoff-e2e-skipped-tests.md.

Current state: fixing 3 skipped E2E tests (container-service, three-tier-web, static-website).

## What's DONE (committed):
- container-service: 15-resource pattern with embedded public-only VPC — E2E PASSES (provision + destroy)
- static-website: CloudFront S3 retry logic + markerRegion() for regional endpoint — provision PASSES, destroy pending verification
- All unit tests: 3526 pass

## Key commits (git log --oneline HEAD~15..HEAD):
- Embedded marker resolution + markerRegion() for CloudFront
- BP compound suppressions (BP-IGW-001/002, BP-RT-001/002) for container-service + three-tier-web
- ECR secure defaults (ScanOnPush + IMMUTABLE) + ECS ClusterSettings (Container Insights)
- ECS Cluster bare ARN synthesis in arn-builder.ts
- ALB Name auto-injection via NAME_FIELDS in plan-generator.ts
- Non-ASCII replacement in SG descriptions (EC2 API rejects em dashes)
- recursionLimit 500→1000 in plan.ts, apply.ts, E2E tests
- CCAPI type filter in bulk-destroy (filters non-conforming RGTA types like AWS::Backup::Recovery-point)
- CloudFront S3 retry: status-poller detects retryable error, routes to resource-provisioner with 30s wait
- ALB ENI drain polling in destroy-service.ts (DescribeNetworkInterfaces after ALB delete)
- **ROOT CAUSE FIX**: Use full ARN for ELBv2 CCAPI deleteResource — extractIdentifier produced app/<name>/<hex> which caused silent NOT_FOUND skip
- afterAll cleanup blocks for all 3 compound tests (IAM roles, RT disassociation, RDS polling)
- RDS required fields (MasterUsername, DBInstanceClass, AllocatedStorage) in three-tier-web
- Explicit DESTROY_TIER entries for VPCGatewayAttachment(1) + SubnetRouteTableAssociation(1)
- destroyAndAssert: 60s tier-boundary wait + ownedIds checks both r.identifier and r.arn

## What's LEFT:
1. Verify static-website E2E destroy completes (CloudFront disable+delete ~15 min)
2. Run three-tier-web E2E (22 resources: full VPC + ALB + EC2 + RDS — expect ~35 min)
3. Run FULL E2E suite (31 tests, ~45 min)
4. bmad-code-review on all changes
5. Squash fix commits into clean history
6. Push to remote
7. Move to next sprint story

## Known risks for three-tier-web E2E:
- RDS creation takes 8-15 min, deletion 5-10 min
- EC2 ImageId resolved via SSM (AmiOs.AMAZON_LINUX_2023) — needs working SSM access
- EC2 needs MasterUserPassword for RDS — check if plan-generator injects it
- Test timeout is 40 min (2,400,000ms) — should be enough but tight

## Files changed (core):
- packages/core/src/pattern-templates/patterns/container-service.ts (15 resources)
- packages/core/src/pattern-templates/patterns/three-tier-web.ts (22 resources)
- packages/core/src/pattern-templates/patterns/static-website.ts (markerRegion)
- packages/core/src/pattern-templates/pattern-resource-ids.ts
- packages/core/src/config/marker-tokens.ts (markerRegion)
- packages/core/src/config/arn-builder.ts (ECS Cluster + DBSubnetGroup ARN)
- packages/core/src/config/resource-types.ts (RDS_DB_SUBNET_GROUP)
- packages/core/src/config/resource-identifiers.ts
- packages/core/src/config/cfn-keys.ts (DB_SUBNET_GROUP_DESCRIPTION)
- packages/core/src/config/iam-actions.ts (DBSubnetGroup IAM)
- packages/core/src/resource-plugins/plugins/rds-db-subnet-group.ts (new)
- packages/core/src/pricing/strategies/rds-db-subnet-group.ts (new)
- apps/cli/src/services/destroy-service.ts (ALB ENI drain + ARN identifier)
- apps/cli/src/services/bulk-destroy.ts (CCAPI type filter + destroy tiers)
- apps/cli/src/services/graph-state.ts (retryCount)
- apps/cli/src/services/graph-routing.ts (retry route)
- apps/cli/src/services/graph.ts (status_poller→resource_provisioner edge)
- apps/cli/src/nodes/status-poller.ts (CloudFront retry detection)
- apps/cli/src/nodes/resource-provisioner.ts (retry wait)
- apps/cli/src/nodes/plan-generator.ts (embedded markers + ALB name injection)
- apps/cli/src/nodes/bp-evaluator.ts (compound suppressions)
- apps/cli/src/e2e/e2e-plan.test.ts (un-skip + assertions + afterAll + destroyAndAssert)
- apps/cli/src/commands/apply.ts (recursionLimit 1000)
- apps/cli/src/commands/plan.ts (recursionLimit 1000)
```

## Sprint status

Check \_bmad-output/implementation-artifacts/sprint-status.yaml for the next story ready for dev.
