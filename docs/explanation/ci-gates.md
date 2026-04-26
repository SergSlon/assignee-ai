# CI Gates — Merge Policy and Acceptable-Miss Window

This document explains the merge-to-main gating policy for Assignee.ai,
with special attention to the nightly E2E gate (real-AWS destroy smoke)
and its acceptable-miss window.

## Gate inventory

| Gate                                            | Trigger                           | Blocks merge?                                                 | Enforced in                                         | Notes                                                                                                                                                                                      |
| ----------------------------------------------- | --------------------------------- | ------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm build`                                    | Every PR + push                   | **Yes**                                                       | `.github/workflows/ci-core.yml`                     | TypeScript must compile in all four packages                                                                                                                                               |
| Prettier format check                           | Every PR + push                   | **Yes**                                                       | `.github/workflows/ci-core.yml`                     | Catches `--no-verify` bypass of the pre-commit `lint-staged` formatter (P077); `pnpm exec prettier --check "**/*.{ts,tsx,json,md}"`                                                        |
| `pnpm test` (vitest, no coverage)               | Every PR                          | **Yes**                                                       | `.github/workflows/ci-core.yml`                     | All unit + integration tests must pass                                                                                                                                                     |
| `pnpm -r test:coverage` (vitest, with coverage) | Every PR                          | **Yes**                                                       | `.github/workflows/ci-core.yml`                     | Per-file coverage floors enforced; exits non-zero below floor                                                                                                                              |
| Destroy-strategy ≥ 80% per-file                 | Every PR (coverage gate)          | **Yes**                                                       | `.github/workflows/ci-core.yml`                     | `packages/core/src/destroy-strategies/**` per-file floor                                                                                                                                   |
| `scripts/audit-action-pins.ts` (W7-01)          | Every PR + push                   | **Yes**                                                       | `.github/workflows/ci-core.yml`                     | Asserts every `uses:` ref in `.github/workflows/*.yml` and `.github/actions/*/action.yml` is pinned to a 40-char SHA                                                                       |
| `scripts/audit-secrets-inherit.ts` (W7-05)      | Every PR + push                   | **Yes**                                                       | `.github/workflows/ci-core.yml`                     | Asserts no workflow uses `secrets: inherit` — every caller declares an explicit `secrets:` block                                                                                           |
| `scripts/audit-overrides.ts` (W7-07)            | Every PR + push                   | **Yes**                                                       | `.github/workflows/ci-core.yml`                     | Asserts every `pnpm.overrides` key has a sidecar entry in `package.json.overrides-rationale.md`                                                                                            |
| `scripts/audit-codeowners.ts` (W9-02)           | Every PR + push                   | **Yes** — ENFORCED                                            | `.github/workflows/ci-security.yml` (audit-scripts) | CODEOWNERS exists at repo root, every entry is well-formed, and a `* @<handle>` global catch-all is present                                                                                |
| `scripts/audit-homebrew-pin.ts` (W7-03)         | Every PR + push                   | **Yes** — ENFORCED                                            | `.github/workflows/ci-security.yml` (audit-scripts) | `--check-template` mode: `homebrew/assignee.rb` uses `${SHA_*}` envsubst placeholders and contains no hardcoded sha256 values (release-time `--check-manifest` mode runs in `release.yml`) |
| `scripts/audit-iam-policies.ts`                 | Every PR + push                   | **Yes** — ENFORCED                                            | `.github/workflows/ci-security.yml` (audit-scripts) | Cross-checks operator/reader/auditor policies against `getRequiredIamActions()` for every `SUPPORTED_TYPES_ARRAY` entry; fails on any missing action                                       |
| `scripts/audit-no-suppress.ts` (W6-02)          | Every PR + push                   | **Yes** — ENFORCED                                            | `.github/workflows/ci-security.yml` (audit-scripts) | Asserts no `\|\| true` masks the exit code of an `assignee` CLI line or `ASSIGNEE_OUTPUT` capture in `.github/actions/*/action.yml`                                                        |
| `scripts/audit-patterns-cleartext.ts` (W1-01)   | Every PR + push                   | **Yes** — ENFORCED                                            | `.github/workflows/ci-security.yml` (audit-scripts) | Scans `~/.assignee/memory/patterns.json` for credential-like strings using the `SENSITIVE_KEY_NAMES` allowlist (exits 0 when file absent)                                                  |
| `pnpm citation-lint`                            | Every PR with doc changes         | **Yes**                                                       | `.github/workflows/ci-core.yml`                     | Broken `file:line` citations in docs are a BLOCKER (see `feedback_citation_lint_guardrail`)                                                                                                |
| **Nightly E2E destroy smoke**                   | Scheduled (nightly, `RUN_E2E=1`)  | **No — acceptable-miss window applies**                       | `.github/workflows/nightly-e2e.yml`                 | Real-AWS provision + destroy per type; see policy below                                                                                                                                    |
| **Mock fixture drift check**                    | Scheduled (nightly, 06:00 UTC)    | **No — acceptable-miss window applies**                       | `.github/workflows/mock-fixture-drift.yml`          | CFN DescribeType vs fixture diff; GitHub issue on every failure; webhook after 3 consecutive                                                                                               |
| Pricing MCP zero-hardcoded-prices               | Every PR                          | **Yes**                                                       | `.github/workflows/ci-core.yml`                     | `scripts/check-mock-fixture-drift.mts` + pricing-decomposer-coverage test                                                                                                                  |
| **FinOps monthly ceiling**                      | Scheduled (weekly, Mon 08:00 UTC) | **No — alerting only; operator must raise budget to unblock** | `.github/workflows/finops-monthly-budget.yml`       | Rolling 30-day spend vs `ASSIGNEE_FINOPS_MONTHLY_BUDGET_USD`; sticky GitHub issue + webhook on breach                                                                                      |

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

When the nightly E2E gate fails outside the acceptable-miss window (3+
consecutive failures), the CI workflow (`.github/workflows/nightly-e2e.yml`)
sends an alert via the configured webhook (Slack / email / PagerDuty,
controlled by repo secret `ASSIGNEE_NIGHTLY_ALERT_WEBHOOK`) and opens or
updates a GitHub issue labelled `nightly-e2e-alert`. The on-call engineer must:

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

#### FinOps monthly ceiling

The per-run cap (`ASSIGNEE_NIGHTLY_BUDGET_USD`) prevents any single nightly run
from over-spending, but cumulative drift — many cheap nightly runs that each stay
under the per-run cap — is not caught by the per-run gate alone. The FinOps
monthly ceiling adds that aggregate layer.

**How it works** — `.github/workflows/finops-monthly-budget.yml` runs every
Monday at 08:00 UTC. It:

1. Downloads all `nightly-cost-ledger-*` CI artifacts from the past 30 days.
2. Runs `scripts/finops-aggregate.mjs` to sum the rolling 30-day spend from the
   per-run JSONL ledger files.
3. If spend exceeds `ASSIGNEE_FINOPS_MONTHLY_BUDGET_USD` (default: $50):
   - Opens or updates a sticky GitHub issue labelled `finops-ceiling`.
   - Fires a webhook alert to `ASSIGNEE_FINOPS_ALERT_WEBHOOK` (falls back to
     `ASSIGNEE_NIGHTLY_ALERT_WEBHOOK` if the dedicated secret is unset; both are
     opt-in). If neither is set, only the GitHub issue is opened.
   - **Fails the workflow** — providing a persistent red signal in the Actions UI
     until the budget is raised or the scope is reduced.
4. If no ledger data is found (fresh repository), a warning annotation is emitted
   and the workflow succeeds — this is not treated as a failure.

**Operator configuration:**

| Secret / Variable                    | Description                                              | Default |
| ------------------------------------ | -------------------------------------------------------- | ------- |
| `ASSIGNEE_FINOPS_MONTHLY_BUDGET_USD` | Rolling 30-day CI spend ceiling in USD                   | `50`    |
| `ASSIGNEE_FINOPS_ALERT_WEBHOOK`      | Webhook destination for ceiling-exceeded alerts (opt-in) | unset   |

The $50 default is a conservative starting point. **Operators should set their
own value** based on their actual nightly-e2e scope and resource portfolio. Set
the value via repo Settings → Secrets (if sensitive) or Settings → Variables
(if non-sensitive).

**To unblock after an alert:**

1. Raise `ASSIGNEE_FINOPS_MONTHLY_BUDGET_USD` in repo Settings → Secrets, **or**
   reduce the nightly-e2e resource scope (remove high-cost types temporarily).
2. Re-run the `finops-monthly-budget` workflow manually via `workflow_dispatch`.
3. Close the `finops-ceiling` tracking issue once the re-run passes.

**Cost figures are never hardcoded** — `scripts/finops-aggregate.mjs` reads all
USD amounts from the JSONL ledger files, which are populated from the Pricing MCP
at runtime. (Per `feedback_no_hardcoded_prices`.)

## Mock fixture drift gate — alert policy

The mock-fixture-drift workflow (`.github/workflows/mock-fixture-drift.yml`)
runs at 06:00 UTC daily, comparing the frozen test fixture
`apps/cli/src/test-fixtures/mcp-mock-responses.ts` against live AWS
CloudFormation `DescribeType` responses for all supported resource types.

### On every failure

A GitHub issue labelled `mock-fixture-drift` is opened (or the existing
open issue is commented on) on every failure — both **drift-detected**
(exit code 2) and **runtime-error** (exit code 1) paths. The drift body
includes the full diff and a link to the
`mock-fixture-drift-report-<run>` artifact; the runtime-error body
links to the workflow run logs for triage. This provides an audit
trail even for single/transient failures and removes the silent-blind
window that existed before R9b-03.

### Acceptable-miss window

Single drift failures may be transient (AWS CloudFormation DescribeType
API hiccups, schema propagation lag). The webhook alert is suppressed
until **3 consecutive failures** occur — the same threshold as the
nightly E2E gate.

### Webhook alert (3+ consecutive failures)

When 3+ consecutive runs fail, a webhook alert is dispatched to:

1. `ASSIGNEE_DRIFT_ALERT_WEBHOOK` — preferred, dedicated drift channel.
2. `ASSIGNEE_NIGHTLY_ALERT_WEBHOOK` — fallback if the dedicated secret
   is unset (a single webhook configuration covers both workflows).

Both are opt-in; if neither is set the webhook step is skipped gracefully
and the GitHub issue remains the sole alerting mechanism.

### On-call response

When a drift alert fires:

1. Download the `mock-fixture-drift-report-<run>` artifact from the
   failing run.
2. Re-baseline the fixture: `pnpm check:mock-fixture-drift --rebaseline`
   (follow the header instructions in `scripts/check-mock-fixture-drift.ts`).
3. Open a PR with the rebased fixture; tag it `mock-fixture-drift`.
4. Close the tracking issue once the PR merges.

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
- `.github/workflows/ci-security.yml` — dedicated audit-scripts workflow (MASTER-003); enforces `audit-codeowners`, `audit-homebrew-pin`, `audit-iam-policies`, `audit-no-suppress`, `audit-patterns-cleartext`
- `.github/workflows/nightly-e2e.yml` — nightly E2E workflow (secret: `ASSIGNEE_NIGHTLY_ALERT_WEBHOOK`)
- `.github/workflows/mock-fixture-drift.yml` — drift check workflow (secrets: `ASSIGNEE_DRIFT_ALERT_WEBHOOK`, `ASSIGNEE_NIGHTLY_ALERT_WEBHOOK`)
- `.github/workflows/finops-monthly-budget.yml` — FinOps monthly ceiling workflow (secrets: `ASSIGNEE_FINOPS_MONTHLY_BUDGET_USD`, `ASSIGNEE_FINOPS_ALERT_WEBHOOK`, `ASSIGNEE_NIGHTLY_ALERT_WEBHOOK`)
- `scripts/finops-aggregate.mjs` — rolling 30-day cost aggregation script
- `scripts/cost-ledger-rollup.ts` — weekly per-run cost ledger rollup
- `packages/core/src/destroy-strategies/destroy-only-tagged-invariant.test.ts`
- `apps/cli/src/e2e/nightly-destroy-smoke.test.ts`
