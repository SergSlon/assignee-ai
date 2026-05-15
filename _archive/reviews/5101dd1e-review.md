# Reviewer: ACCEPT — Quinn (qa) — EPIC-106-STRATEGIES

# EPIC-106 Strategies Cost-Label Re-Review — 5101dd1e

## Verdict

ACCEPT. All four blocking findings from the `b2b246b9` bounce are resolved,
the optional Lambda-fixture finding is also resolved, and the original
closure criteria from the prior review hold on the amended commit.

The amendment touches exactly the five expected files (CHANGELOG.md,
price-units.ts, strategies/sqs.ts, strategies/unit-label-convention.test.ts,
test-fixtures/checkpoints/single-lambda-scheduled.json) with +26/-10 LOC —
narrow, surgical, no collateral edits.

## Bounce-resolution check

1. **SQS site fixed** — `packages/core/src/pricing/strategies/sqs.ts:34`
   now reads `unit: PriceUnit.PER_MILLION_REQUESTS,` (was
   `PER_MILLION_REQUESTS_LONG`). Verified via
   `git show 5101dd1e:packages/core/src/pricing/strategies/sqs.ts | sed -n '25,40p'`.
   The mcpConfig unit therefore resolves to canonical `/M requests`.

2. **Dead constant removed** — `packages/core/src/pricing/price-units.ts`
   no longer declares `PER_MILLION_REQUESTS_LONG`. The full file shows only
   `PER_HOUR_LONG` and `PER_GB_MONTH_LONG` remaining in the "Long-form
   variants" section. Repo-wide grep
   `git grep -n PER_MILLION_REQUESTS_LONG -- packages/core/` returns zero
   matches (exit 1), so no stale references survive.

3. **Guard test extended** — `unit-label-convention.test.ts` now imports
   `sqsPricingStrategy` and includes it in `TARGET_STRATEGIES`. The
   `DESIRED_STATES` array adds `{ FifoQueue: false }` and `{ FifoQueue: true }`,
   so the SQS mcpConfig is exercised under both Standard and FIFO queue
   shapes via the per-state loop. Two new explicit spot-check tests pin
   the exact canonical value:
   - `"SQS mcpConfig unit is /M requests"` (Standard)
   - `"SQS mcpConfig unit is /M requests (FIFO queue)"` (FIFO)
     Both assert `config?.unit === "/M requests"`. Adequate guard against
     future drift on either branch.

4. **CHANGELOG corrected** — entry now says "Six sites across SQS /
   DynamoDB / Lambda / SNS / ApiGatewayV2 (WebSocket + HTTP)" with
   explicit SQS site call-out (`strategies/sqs.ts (mcpConfig unit
/million requests → /M requests)`) and the dual apigatewayv2 sites
   (WebSocket mcpConfig + HTTP mcpConfig) enumerated separately. The
   dead-constant removal is mentioned. User-visible blurb extended with
   `SQS mcpConfig unit normalised from /million requests to /M requests`.
   Honest and accurate.

5. **Lambda fixture updated** — `single-lambda-scheduled.json`
   `estimatedMonthlyCost` field flipped from `~$1.03/million req (...)` to
   `~$1.03/M requests (...)`. Matches the runtime label format and keeps
   the checkpoint fixture honest with the strategy's output.

## Closure criteria re-verified

- **No remaining hardcoded `/million` in strategies** —
  `git grep -nE "'/million|\"/million" -- packages/core/src/pricing/strategies/`
  returns zero matches (exit 1). Strategies layer is now entirely
  routed through `formatUnitSuffix` / `PriceUnit` constants.
- **Original 4 sites still correct** — DynamoDB, Lambda, SNS,
  ApiGatewayV2 (WebSocket + HTTP) spot-check assertions remain in the
  guard test (`/M write reqs`, `/M requests` Lambda, `/M publishes`,
  `/M messages`). No regression introduced by the amendment.
- **Test-fixture updates honest** — the only fixture change is the
  Lambda one, and its `estimatedMonthlyCost` matches the runtime label
  format the strategy now produces. No silent assertion weakening.
- **Diff scope sane** — `git diff b2b246b9..5101dd1e --stat` reports
  5 files, +26/-10 LOC. Nothing outside the bounce findings touched.

## Findings

None.

## Notes

- Out-of-scope follow-up: `packages/core/src/constants/pricing-api.ts:62`
  still exports a parallel `MILLION_REQUESTS` constant. Per your
  earlier scope decision and this re-review's instructions, this is
  flagged as a paydown item, not a blocker. Worth bundling into a
  later "constants consolidation" sweep so there is exactly one
  canonical per-million unit definition in the codebase.
- The guard test's spot-check coverage of SQS is symmetric to the other
  strategies (one canonical-value assertion per strategy plus the
  generic loop). No further test work needed for this scope.
