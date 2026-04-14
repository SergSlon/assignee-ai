# Next Session: Address Expert Review Findings, Then Continue Dev

## Context

Previous session completed "fix 3 skipped E2E tests" — all 3 passing in live AWS.
27 commits pushed to `main` (ba2d65d..c9a83f9).
E2E: 31 pass / 0 fail / 0 skip. Unit tests: 3526 pass.

Three expert reviews were completed on those commits. Findings saved in
`.agents/reviews/`. 1 BLOCKER already fixed (ARN_IDENTIFIED_TYPES extended).
Remaining HIGH/WARNING/INFO items need attention before Epic 47 work.

## Paste this prompt to continue:

```
Read .agents/agent-teams-bmad-guide.md and survey state:
  - git log --oneline -10 (should show c9a83f9 at HEAD)
  - pnpm build && pnpm test (expect 3526 pass)
  - Read the 3 expert reviews: .agents/reviews/security-expert-e2e-fixes.md,
    architect-expert-e2e-fixes.md, qa-expert-e2e-fixes.md

## Priority 1: Address remaining BLOCKER/HIGH findings

### Security HIGH (security-expert-e2e-fixes.md #1)
Hardcoded RDS MasterUserPassword sentinel in three-tier-web.ts. Fix:
  - Add preflight-guard check: if MasterUserPassword === "ChangeMe-REPLACE-123!"
    reject with actionable error "override via --set MasterUserPassword=<real>"
  - Mirrors the existing placeholder-ARN preflight pattern at
    apps/cli/src/nodes/preflight-guard.ts:65

### QA BLOCKERs (qa-expert-e2e-fixes.md B1-B4)
Add unit tests for:
  B1. marker-tokens.test.ts — markerRegion(), parseMarker with REGION,
      MARKER_PATTERN regex (packages/core/src/config/marker-tokens.ts)
  B2. status-poller.test.ts — isRetryableCloudFrontS3Error with each error pattern
  B3. bulk-destroy.test.ts — CCAPI_TYPE_PATTERN filter (accepts AWS::X::Y,
      rejects AWS::Backup::Recovery-point lowercase hyphen)
  B4. rds-db-subnet-group.test.ts — plugin structure, required fields

## Priority 2: Address WARNINGs (lower priority, batch before next big change)

Architect WARNINGs:
  - Tighten isRetryableCloudFrontS3Error regex (scope "does not exist" with
    origin/bucket/s3 co-occurrence guard)
  - Move DBSubnetGroup to its own destroy tier (between RDS=3 and Subnets=4)
  - Log CCAPI_TYPE_PATTERN dropped types at INFO (currently silent)
  - Extract embedded marker regex to shared constant in marker-tokens.ts
  - Hoist await import("@aws-sdk/client-ec2") to module-level in destroy-service

QA WARNINGs:
  - Fix destroyAndAssert comment/code mismatch (30s vs 60s)
  - E2E assert exact resource count + explicit types (not just >= count)
  - Scope afterAll cleanup to current run (see staticSuffix slice issue)

Security MEDIUM:
  - Add tag-based IAM condition (aws:ResourceTag/assignee-managed) to RDS
    snapshot Resource: * permissions

## Priority 3: Next story (Epic 47)

After all P1/P2 items are resolved, move to Epic 47. Stories ready-for-dev:
  - 47-2 plan-only coverage gaps — 12 uncovered resource types (M)
  - 47-3 free-tier apply-destroy — ~12 free-tier resources (M)
  - 47-5 cheap compute lifecycle — Lambda ✓, EFS ✓, EC2 t3.micro new (S)
  - 47-6 moderate cost timeboxed — RDS db.t3.micro, NAT Gateway (S)

Read story files under _bmad-output/implementation-artifacts/47-*.md. Pick
based on leverage × dependency chain.

## MANDATORY workflow rules (per CLAUDE.md + past lessons)

1. ALWAYS use BMAD skills via Skill tool (bmad-dev-story, bmad-code-review).
   NEVER work ad-hoc or spawn role-name subagents.
2. For E2E tests: SINGLE test only (not regex that matches multiple).
   vitest -t runs each matching test separately → doubles runtime.
3. Pre-clean AWS orphans before each E2E (VPCs, ALBs, RDS, ECR, ECS).
4. aws login check before any E2E (session expires frequently).
5. Verify operator IAM has required actions — iam-actions.ts is source of
   truth, but may need put-user-policy to refresh AWS-side for new actions.
6. Mandatory gates after each story:
   a. pnpm build && pnpm lint && pnpm test
   b. bmad-code-review via Skill tool
   c. Commit + push
```

## Expert review highlights

### Clean / OK:

- CloudFront OAC S3 lockdown (BlockPublicAcls, aws:SourceArn, HTTPS-only)
- No command injection (all AWS via SDK)
- ALB ENI drain architecture (canonical AWS technique)
- markerRegion() integrates cleanly with existing markers

### Needs work:

- Security: 1 HIGH (RDS password sentinel enforcement)
- Architect: BLOCKER FIXED (ARN_IDENTIFIED_TYPES extended), 9 WARNINGs pending
- QA: 4 BLOCKERs (missing unit tests for new production code)

## Lessons learned

- CCAPI uses CFN schema field names (VPCSecurityGroups not VpcSecurityGroupIds)
- CCAPI deleteResource for ARN-identified types needs full ARN, not extracted
- CloudFront deployments: 10-15 min (poll timeout now 20m)
- RDS deletion: 5-15 min (DESTROY_MAX_POLL_ATTEMPTS now 600)
- EC2 rejects non-ASCII in SG descriptions (no em dashes, arrows)
- RDS IAM needs snapshot perms even with SkipFinalSnapshot=true
- Pattern NAME_FIELDS auto-injects unique names; don't hardcode
- afterAll cleanup must scope to CURRENT run (by runId / recent CreatedTime)
- vitest -t regex matches multiple → runs each separately → avoid for E2E
