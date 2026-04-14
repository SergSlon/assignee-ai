# Blind Hunter — cf55d7d + c269379 (Epic 47 post-live-AWS)

## HIGH (blocking)

1. **SNS Subscription assertion wildcarded** — accepts 9 protocols; intent says "email" with email endpoint. Tighten to `.toBe("email")` + assert Endpoint shape matches.
2. **KMS KeyPolicy assertion dropped** — self-contradicting rationale (if plugin injects at apply, user's approved plan ≠ executed plan). Restore + investigate plan-mode state.

## IAM SECURITY

- **S2 CreateDBSnapshot unscoped** — my fix left it unscoped in service sweep. Attacker could Create→ModifyDBSnapshotAttribute→share to cross-account. Recommend `aws:RequestTag/managed-by=assignee-ai` scope (evaluates tag at create time) + verify `rds:ModifyDBSnapshotAttribute` isn't unscoped.
- S1 GetRandomPassword unscoped — OK, it's Resource:\* only per AWS docs, no attack surface.

## MEDIUM

- M1 isRetryable denylist brittleness — "access identity"/"request policy" substrings miss CachePolicy, ResponseHeadersPolicy, RealtimeLogConfig. Prefer allowlist per project memory.
- M2 `completedResources ?? [...]` — fires only on null/undefined, not `[]`. Use `?.length`.
- M3 cost assertion in helper uses bare `toBeTruthy()` — accepts "N/A" / "Free" / "$0". Tighten to `.not.toBe("N/A")`.
- M4 ELBv2 `scheme === null` silently skips drain — no warn log. Add structured `elbv2.scheme.unknown` log.

## LOW

- L1 bare-identifier arnRegex too permissive
- L2 `recursionLimit: 500` + 240s magic numbers — hoist to env-overridable constants
- L3 SkipFinalSnapshot only in skipped RDS block; verify three-tier-web compound carries it
- L4 capturedRunId describe-scope concurrency risk

## Gate: 3 blockers (H1, H2, S2)
