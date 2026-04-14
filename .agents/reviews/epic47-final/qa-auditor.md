# QA Auditor — cf55d7d + c269379 (Epic 47 post-live-AWS) — GATE: FAIL

## Must-fix blockers

1. **KMS KeyPolicy assertion dropped** (weakening) — restore `.toBeTruthy()` on KeyPolicy. Dropped in favor of trivially-passing typeof(KeyUsage)/typeof(KeySpec). Comment rationale self-contradicts.
2. **SNS Protocol `.toBe("email")` → enum wildcard** (weakening) — intent phrasing was strengthened to "Protocol=email"; assertion should tighten in lockstep, not relax.
3. **presetFields numeric coercion gap** — option-elicitor.ts:114-121 coerces only "true"/"false". `AllocatedStorage: "20"` stays string. CCAPI may reject or coerce downstream. RDS block is skipped so this is hidden, but EC2 InstanceType="t3.micro" (string is correct) vs future numeric fields have latent bug.

## Deferred / brittleness

- EngineVersion "16.9" hardcoded — Story 44.3 pattern says dynamic discovery via DescribeDBEngineVersions. Fix with RDS un-skip.
- AssigneeOperatorSecretsManagerGap ephemeral inline policy — should remove after regenerating canonical AssigneeOperator managed policy from new iam-actions.ts list. Otherwise drift.

## Analysis (non-blocking but important)

- EventBridge skip: accurate diagnosis, but fixable (pre-create SNS target). Convenient deferral.
- RDS skip: real default-VPC mismatch. three-tier-web compound covers full lifecycle. Legitimate deferral.
- Verification claim misleading: 11 active free-tier + 1 EC2 + 1 RDS(skip) + 1 EventBridge(commented) = 13 intended. "9/12 pass" ambiguous — 9 individual live passes out of 11 active + 1 EC2 = 12.

## Source-of-truth IAM fix

✓ iam-actions.ts:383 `secretsmanager:GetRandomPassword` added — doctor/audit will pick it up on next policy regen. Persistent fix in place.
⚠ Temporary AssigneeOperatorSecretsManagerGap inline should be removed after regen.
