# Edge Case Hunter — unreviewed commits (2 BLOCKERS)

## HIGH (blocking)

### H1. `userOverrides` field NOT in AgentState — 14 new lifecycle tests silently ignore overrides

- File: `apps/cli/src/e2e/e2e-plan.test.ts` (EC2, RDS, 12 free-tier blocks)
- Evidence: `grep -r userOverrides packages/core apps/cli/src/services/graph-state.ts` → no matches. TS cast `as Parameters<typeof graph.invoke>[0]` hid it at compile time.
- Impact: RDS may run as db.m5.large ($0.35/hr), EC2 may be non-free-tier, `SkipFinalSnapshot` + `MasterUserPassword` overrides dropped.

### H2. `aws:ResourceTag/managed-by` blocks legit CreateDBSnapshot

- File: `packages/core/src/config/iam-policies.ts:292-311`
- Evidence: Per AWS IAM docs, `rds:CreateDBSnapshot` evaluates condition against BOTH source DBInstance AND new snapshot. New snapshot has no tag yet → AccessDenied.
- My commit message claim "evaluates against the source DBInstance" is partially wrong; correct pattern is `aws:RequestTag/managed-by` on create + `aws:ResourceTag` on source.

## MEDIUM

### M1. isRetryable "origin" co-occurrence false-positive (agrees with Blind HIGH #3)

- "The origin access identity E1ABC does not exist" (OAI config error, non-retryable) now retries.

### M2. DBSubnetGroup tier 3.5 → TWO 60s tier-boundary sleeps per RDS destroy (was one)

- 3→3.5→4 instead of 3→4. Adds 60s to every RDS destroy, tightens 600s timeout.

### M3. NLB/GWLB scheme fallback `?? "app"` silently masks future schemes

- Should be `?? null` with explicit log + fall through to 60s blind sleep.

## LOW

- L1. KMS ARN/UUID normalization edge in destroyAndAssert match
- L2. `toBeTruthy()` accepts "Free"/"$0.00" for paid resources in free-tier helper — pricing regression signal lost
- L3. Lambda preflight re-anchor loses original decomposer-call detection capability (acknowledged in comment)
- L4. MARKER_PATTERN_GLOBAL per-call allocation at first call site (line 528) is wasteful (replace doesn't need new instance)
- L5. Hardcoded `E2eAssigneeRds2026` — dead weight once H1 is fixed
