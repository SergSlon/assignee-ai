# QA Auditor — unreviewed commits (CONDITIONAL PASS)

## Blockers (Medium)

1. **SecretsManager `skipCostAssertion: true`** — bad justification ($0.40 IS a valid truthy headline). Remove skip, keep `toBeTruthy()`. Catches "N/A" regression.
2. **RDS `SkipFinalSnapshot: true` MISSING** from userOverrides — comment claims it's set, code doesn't set it. Every failed e2e RDS run leaks a snapshot → bills indefinitely. Direct contradiction of story's cost-cap AC.
3. **8/12 arnRegex bare-identifier fallbacks too permissive** — e.g., LogGroup `[A-Za-z0-9/_.#\-]+` matches any non-empty UUID. Defeats "detect request-token regression" intent. Tighten per AWS rules OR drop bare branch (enforce arn-builder contract).

## Context gap

- d5c8dad (Lambda preflight test re-anchor) NOT in /tmp/unreviewed.patch — excluded by my filter accidentally. Needs separate audit.

## Passes

- e548465 plugin guards: `toBeDefined` → `typeof === "function"` strictly strengthening ✓
- EC2 regex `/^i-[0-9a-f]{17}$/` correct ✓
- RDS password `E2eAssigneeRds2026` passes sentinel guard (verified PLACEHOLDER_DB_PASSWORDS set) ✓
- `toBe(15)` / `toBe(22)` exact counts strengthen ✓

## Low (non-blocking)

- SNS regex ARN-only vs others bare-accepting inconsistency — document arn-builder contract
- RDS bare-id regex loose but lower priority than #3
- Long-lived `describe.skip` (Events Connection/ApiDestination) — regression rot risk
