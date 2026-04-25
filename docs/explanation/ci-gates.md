# CI Gates — Merge Policy and Acceptable-Miss Window

This document explains the merge-to-main gating policy for Assignee.ai,
with special attention to the nightly E2E gate (real-AWS destroy smoke)
and its acceptable-miss window.

## Gate inventory

| Gate                                            | Trigger                          | Blocks merge?                           | Notes                                                                                       |
| ----------------------------------------------- | -------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------- | --- | ------------------------------------------------------------ |
| `pnpm build`                                    | Every PR + push                  | **Yes**                                 | TypeScript must compile in all four packages                                                |
| `pnpm test` (vitest, no coverage)               | Every PR                         | **Yes**                                 | All unit + integration tests must pass                                                      |
| `pnpm -r test:coverage` (vitest, with coverage) | Every PR                         | **Yes**                                 | Per-file coverage floors enforced; exits non-zero below floor                               |
| Destroy-strategy ≥ 80% per-file                 | Every PR (coverage gate)         | **Yes**                                 | `packages/core/src/destroy-strategies/**` per-file floor                                    |
| `scripts/audit-no-suppress.ts`                  | Every PR                         | **Yes**                                 | Asserts no `                                                                                |     | true`on assignee CLI lines in`.github/actions/\*/action.yml` |
| `pnpm citation-lint`                            | Every PR with doc changes        | **Yes**                                 | Broken `file:line` citations in docs are a BLOCKER (see `feedback_citation_lint_guardrail`) |
| **Nightly E2E destroy smoke**                   | Scheduled (nightly, `RUN_E2E=1`) | **No — acceptable-miss window applies** | Real-AWS provision + destroy per type; see policy below                                     |
| Pricing MCP zero-hardcoded-prices               | Every PR                         | **Yes**                                 | `scripts/check-mock-fixture-drift.mts` + pricing-decomposer-coverage test                   |

## Nightly E2E gate — merge policy

The nightly real-AWS destroy smoke (`apps/cli/src/e2e/nightly-destroy-smoke.test.ts`)
runs against live AWS infrastructure. It is **not a merge gate** for
individual PRs, because:

1. It provisions and destroys real resources, which takes minutes per
   type and incurs cost. Running it on every PR would exceed the
   `$1/day` cost ceiling (see `feedback_daily_cost_ceiling`).
2. Transient AWS service outages cause intermittent failures that are
   not attributable to code changes. The nightly cadence provides a
   signal-to-noise ratio that per-PR doesn't.

### Acceptable-miss window

A nightly E2E run MAY be treated as non-blocking under ALL of the
following conditions:

| Condition            | Requirement                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| Consecutive failures | ≤ 2 consecutive nightly runs may fail without blocking main                                       |
| AWS service health   | The AWS Service Health Dashboard shows an active incident for the failing resource type's service |
| Failure scope        | Failure is isolated to a single resource type; other types passed                                 |
| Cost cap             | Total run cost did not exceed `ASSIGNEE_NIGHTLY_BUDGET_USD` (default: $5/day)                     |

If **any** of the above conditions is not met — specifically if 3+
consecutive nightly runs fail, or if failures span multiple resource
types without a corresponding AWS incident — the failure MUST be treated
as a BLOCKER on merging new code to main until it is resolved.

### Alert escalation

When the nightly E2E gate fails outside the acceptable-miss window, the
CI workflow (`.github/workflows/nightly-e2e.yml`) sends an alert via
the configured channel (Slack / email / PagerDuty stub, controlled by
`ASSIGNEE_NIGHTLY_ALERT_CHANNEL`). The on-call engineer must:

1. Check AWS Service Health Dashboard for the affected region.
2. Reproduce locally: `RUN_E2E=1 pnpm vitest run src/e2e/nightly-destroy-smoke.test.ts`.
3. If code-related: open a P1 bug, assign to the last code-change owner for the failing type.
4. If AWS transient: add a `# skip-reason: AWS incident <ID>` annotation in the CI run summary.

### Cost cap

Each nightly run asserts `ASSIGNEE_NIGHTLY_BUDGET_USD` (default `5`).
Resources are provisioned cheapest-first; the test suite exits early
and emits a `budget_exceeded` event to the cost ledger if the
estimated remaining resources would breach the cap.

The cost ledger is written to `~/.assignee/logs/nightly-cost-YYYY-MM-DD.jsonl`
and uploaded as a CI artifact. The weekly rollup script
`scripts/cost-ledger-rollup.ts` aggregates these into a per-week total.

## Coverage floors

Per-file coverage floors are configured in
`packages/core/vitest.config.ts` under `test.coverage.thresholds`.
The destroy-strategies directory enforces ≥ 80% line coverage per file.
Raising the global floor requires a separate PR with evidence that the
new floor is stable across 3+ CI runs.

## Adding a new gate

New quality gates MUST be:

1. Added to this document before they are wired into CI.
2. Set to **blocking** or **non-blocking** with an explicit rationale.
3. Covered by a `scripts/` lint script or a vitest test file, not
   inline shell logic in a workflow file.
4. Announced in the sprint status update the week they are added.

## References

- `feedback_daily_cost_ceiling` — $1/day Claude harness cost ceiling
- `feedback_no_hardcoded_prices` — all prices from Pricing MCP at runtime
- `feedback_mandatory_quality_gates` — five hard blocking gates after every story
- `feedback_run_coverage_before_push` — CI uses `pnpm -r test:coverage`
- `feedback_citation_lint_guardrail` — citation lint after doc changes
- `packages/core/src/destroy-strategies/destroy-only-tagged-invariant.test.ts`
- `apps/cli/src/e2e/nightly-destroy-smoke.test.ts`
