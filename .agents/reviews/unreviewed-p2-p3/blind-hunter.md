# Blind Hunter — unreviewed commits 5713ce7..e548465 (13 commits)

## HIGH

1. SQS arnRegex rejects `.fifo` suffix (FIFO queue names end in `.fifo`) — regex uses `[A-Za-z0-9_-]+`, no dot. Latent: test doesn't exercise FIFO today.
2. CloudWatch LogGroup arnRegex — `:\*?` makes trailing `:*` optional but allows orphan-colon malformed ARNs to pass. Weak assertion.
3. **isRetryableCloudFrontS3Error co-occurrence check false-positives on "origin"** — "Origin request policy does not exist" now retries, burning 3-retry budget exactly as W2 sought to prevent. Real regression introduced by 86f3f4d.

## MEDIUM

4. MARKER_PATTERN_GLOBAL comment rationale wrong — `String.replace(/g)` does NOT leak `lastIndex` between calls (only `exec()`/`test()` do). Per-call `new RegExp` is unnecessary for resolveValue (which uses replace).
5. CreateDBSnapshot legitimate flow at risk if DBInstance was detagged — operator locked out. Consider `aws:RequestTag` secondary allowance.
6. ELBv2 scheme fallback `schemeMatch?.[1] ?? "app"` silently re-introduces NLB/GWLB miss when identifier is odd-shaped. Should fail-closed.
7. `destroyAndAssert` 60s tier-boundary sleep eats timeout budget for single-resource free-tier blocks (KMS 180s).
8. DBSubnetGroup tier 3.5 — risk if any consumer uses `Math.floor(tier)` or integer keys. Diff only shows assignment, no consumer verification.

## LOW

9. KMS `ScheduleKeyDeletion` leaves $1/key/mo for 7 days with no cleanup registry.
10. `capturedRunId` at describe scope — racy if vitest ever switches to `describe.concurrent`.
11. `markerGetAtt` underscore throw is a DX cliff — fix parser, not constrain inputs.
12. `completedResources ?? [{...}]` fallback doesn't trigger on empty array `[]` (only on nullish) — masks apply-failed-mid-flight cases.

## INFO

13. `CCAPI_TYPE_DROPPED` log uses literal `runId: "bulk-destroy"` — poisons runId-grouped log analytics.
