# Next Session: Continue Dev on Epic 47

## Context

Previous session completed "fix 3 skipped E2E tests" — all 3 now passing in live AWS.

- 26 commits pushed to `main` (ba2d65d..d3504c7)
- E2E score: 31 pass / 0 fail / 0 skip
- Unit tests: 3526 pass

Three expert reviews were run on those 26 commits (security / architect / QA).
Results saved in the last conversation — if there were any BLOCKER findings, handle
them FIRST before starting the next story.

## Paste this prompt to continue:

```
Read .agents/agent-teams-bmad-guide.md. Then survey current state:
  - git log --oneline -30 (should show ba2d65d..d3504c7 range merged)
  - git status (should be clean on main)
  - Auto-memory at ~/.claude/projects/-Users-serhii-l-code-GenAi/memory/
  - Run `pnpm build && pnpm test` — expect 3526+ tests passing
  - Check _bmad-output/implementation-artifacts/sprint-status.yaml for next story

First, check .agents/reviews/ for any BLOCKER findings from the 3 expert reviews
(security-expert, architect-expert, qa-expert). If any BLOCKER exists, fix and
commit BEFORE starting the next story.

Next story candidates (all ready-for-dev in Epic 47):
  - 47-2 plan-only coverage gaps — add plan tests for 12 uncovered resource types
  - 47-3 free-tier apply-destroy — apply+destroy lifecycle for ~12 free-tier resources
  - 47-5 cheap compute lifecycle — Lambda ✓, EFS ✓, EC2 t3.micro new test
  - 47-6 moderate cost timeboxed — RDS db.t3.micro new test, NAT Gateway via VPC compound
  - 47-7 compound pattern sweep
  - 47-8 bug triage fix stories

Read each story file under _bmad-output/implementation-artifacts/47-*.md and
propose which to tackle first (consider: leverage, blast radius, dependencies).

Use BMAD workflow (mandatory per CLAUDE.md):
  1. bmad-create-story (if story file needs refinement) — Skill tool
  2. bmad-dev-story — Skill tool
  3. bmad-code-review — Skill tool (after implementation)

For E2E tests:
  - Single test only: RUN_E2E=1 pnpm vitest run src/e2e/e2e-plan.test.ts -t "SPECIFIC NAME"
  - NEVER use regex filter that matches multiple tests — vitest runs each match
    separately which doubles runtime and exhausts AWS account limits.
  - Pre-clean AWS orphans before each run (VPCs, ALBs, RDS, ECR, ECS).

Do NOT spawn ad-hoc subagents for code review — use the bmad-code-review skill
via the Skill tool per CLAUDE.md BMAD rules.

Before any E2E apply test:
  - aws login check (session often expires)
  - Verify operator IAM has all needed actions (iam-actions.ts is the source of
    truth; may need `put-user-policy` to refresh AWS-side)

Key learnings from previous session (avoid repeating):
  - CCAPI uses CFN-schema field names (VPCSecurityGroups not VpcSecurityGroupIds,
    MetadataOptions.HttpTokens not top-level)
  - CCAPI deleteResource for ELBv2 needs the FULL ARN, not extractIdentifier output
  - CloudFront deployments take 10-15 min — poll timeout is now 20 min
  - RDS deletion takes 5-15 min — DESTROY_MAX_POLL_ATTEMPTS is now 600
  - EC2 rejects non-ASCII in SG descriptions (no em dashes)
  - RDS IAM needs snapshot perms even with SkipFinalSnapshot=true
  - Pattern NAME_FIELDS auto-injects unique names; don't hardcode in patterns
  - afterAll cleanup must scope to CURRENT run (staticSuffix / recent CreatedTime)
```

## Handy references

- Previous session's handoff: `.agents/handoff-e2e-skipped-tests.md`
- BMAD team guide: `.agents/agent-teams-bmad-guide.md`
- Sprint status: `_bmad-output/implementation-artifacts/sprint-status.yaml`
- Story files: `_bmad-output/implementation-artifacts/47-*.md`
