# Reviewer: ACCEPT — qa (Quinn) — 108-B-02-reducer-correctness

**Commit (pre-amend)**: `f8b41009` — fix(graph): accumulator reducers for estimatedMonthlyCost + pricingBreakdown (108-B-02)
**Base**: `7ae465a3` (origin/main)
**Story spec**: `_bmad-output/implementation-artifacts/epic-108-B-02-reducer-correctness.md`
**Epic**: 108-B Quality Infrastructure — Systemic Gap 8 fix

## Scope

- `packages/core/src/graph/graph-state.ts` — 123 lines added: `parseCostLabelToNumber`, `accumulateCostLabel`, `accumulatePricingBreakdown`, wired into `graphAnnotation`. PD-2 reset semantics preserved. `// TODO 108-B-04` comment at `classifierPath` for next wave.
- `packages/core/src/graph/__tests__/graph-state-reducers.test.ts` — NEW, 35 unit tests across Axes A-H.
- `packages/core/src/graph/__tests__/compound-plan-cost-accumulation.test.ts` — NEW, 10 integration tests using real `StateGraph(graphAnnotation)`. AC #7 pre-fix failure evidence documented in test header + assertion at lines 147-161.
- `CHANGELOG.md` — `### Fixed` under `## [Unreleased]`.

4 files, 840 insertions / 6 deletions.

## Verification (Opus reviewer, single round)

**parseCostLabelToNumber regex correctness (5+ edge cases)**: PASS

- `"$12.34/mo"` → 12.34, `"~$0.50/mo"` → 0.5, `"$3.00/mo (live)"` → 3 ✅
- `"$0.023/GB"` → null, `"N/A"` → null, `"Free"` → null ✅
- `"$.50/mo"` → null (no leading digit; acceptable edge case)

**accumulateCostLabel paths (A/B/C/D)**: ALL PASS

- A both parseable → sums, reformats as `"$X.XX/mo"` via `toFixed(2)`
- B one unparseable → falls back to b (last-write-wins, documented)
- C `b === undefined` → returns undefined (PD-2 reset preserved)
- D both undefined → returns undefined (test 203-205)

**accumulatePricingBreakdown**: PASS — merges `fixedItems`/`usageBasedItems`, sums `fixedSubtotal`, ORs booleans, picks latest `fetchedAt`. PD-2 reset preserved per AC#4.

**Variant test depth (Gap 7 hardline)**: 35 unit + 10 integration verified by count. Axes A-H all present as explicit `describe` blocks in both files.

**AC#7 pre-fix failure evidence**: PASS — test header lines 13-22 + assertion lines 147-161 document pre-fix `"$25.00/mo"` (RDS only) vs post-fix `"$50.00/mo"` (S3+Lambda+RDS sum).

**Adversarial scenarios**: PASS

- Mixed `Free`/`$3` reverts to last-write-wins (documented design; tests confirm).
- `"$0.023/GB"` after `"$10.00/mo"` falls back to last-write-wins on usage-rate (test 213-216).
- Reducer purity: both functions closed-over-nothing, no mutation (tests 162-176 + 354-373).

**Type stability**: type unchanged (`string | undefined`); `plan.ts` and `apply-single.ts` consumers unaffected.

**Regression scan**: 113 test files / 2658 tests pass in `packages/core/src/graph/`. No snapshot churn.

**TODO 108-B-04**: correctly placed at `graph-state.ts:175`, cites correct story.

**Build/CHANGELOG/commit message**: ALL PASS.

## Advisory findings for B-03 (NOT blockers)

- **F1 MED** `graph-state.ts:227` — when `preflight-guard` emits `pricingBreakdown: undefined` for a non-decomposable resource mid-compound-plan, accumulated breakdown resets per PD-2. B-03 should prefer `pricingBreakdown.fixedSubtotal` over reading the parsed string label, AND consider iterating `perResourceCosts` (Record<string,string>) for compound totals when reducer falls back to last-write-wins. Document in B-03 spec.
- **F2 LOW** `accumulateCostLabel:131` — when one label is `"Free"` (e.g. IAM Role companion in compound), the accumulated header falls back to "Free" or the latest priced label, NOT a true sum. B-03 cost-leading consumer should sum `pricingBreakdown.fixedSubtotal` independently for the cost header rather than rely on `estimatedMonthlyCost`.

## Verdict

ACCEPT — Systemic Gap 8 fix lands cleanly. Path A (accumulator + string-label format roundtrip) followed per spec; B-03 will need to consume `fixedSubtotal` for the cost header (advisory tracked in B-03 spec).
