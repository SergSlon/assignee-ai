# Reviewer: ACCEPT — qa (Quinn) — 108-B-03-cost-leading-plan-output

**Commit (pre-amend)**: `5e3a2980` — feat(plan): cost-leading plan output + --cost-detail flag
**Round-1**: `170dd4fe` — BOUNCED on BLOCKER scope violation (2 A-02 files included) + HIGH harness non-use + MED docs deviation
**Round-2**: `7f595c90` — BOUNCED on HIGH `--cost-detail` flag not registered in shipped-wired-contract
**Round-3**: `5e3a2980` — ACCEPTED
**Base**: `fec838e2` (origin/main post B-01 + B-02 merges)
**Story spec**: `_bmad-output/implementation-artifacts/epic-108-B-03-cost-leading-plan-output.md`
**Epic**: 108-B Quality Infrastructure — Wave 1

## Scope (15 files)

- `apps/cli/src/commands/plan/arg-parser.ts` — `--cost-detail` flag parse
- `apps/cli/src/commands/plan/orchestrator.ts` — `setCostDetailEnabled()` + `resetTokenUsage()` at start; cost block reiterated before HITL confirm (post Story 50-2 unified path)
- `packages/core/src/graph/nodes/result-formatter/formatters/plan.ts` — `formatCostBlock()` primary reads `pricingBreakdown.fixedSubtotal`
- `packages/core/src/graph/nodes/result-formatter/formatters/plan.test.ts` — 125 tests (49 original + 76 registry-driven via `enumerateTypes()` + `defaultDecomposerRegistry`)
- `packages/core/src/graph/nodes/result-formatter/result-formatter.test.ts` — display-mock extension
- `packages/core/src/utils/cost-block-types.ts` — NEW shared `CostBlock` interface (breaks circular import)
- `packages/core/src/utils/display-plan.ts` — NEW `renderCostBlock()` TTY/non-TTY
- `packages/core/src/utils/display-plan.test.ts` — 8 tests for renderCostBlock variants
- `packages/core/src/utils/display.ts` — barrel
- `packages/core/src/pricing/barrels/utils.ts` — barrel
- `packages/core/src/__tests__/shipped-wired-contract.test.ts:240-244` — `--cost-detail` whitelisted with comment citing Axes I/J/K coverage in plan.test.ts
- `completions/_assignee` / `completions/_assignee.ps1` / `completions/assignee.fish` — flag completion
- `CHANGELOG.md` — Unreleased entry

## Verification across 3 rounds

**Round 1** — Dev introduced 2 A-02 files (lambda-iam-autorole.ts + permission-denied-classification.test.ts, 479 LOC total) labelled as "pre-existing fixes" — scope violation. 49 new tests hardcoded resource-type literals — Gap 7 harness ignored. Apply.ts AC#5 wiring landed in plan/orchestrator.ts instead (correct per Story 50-2 but undocumented).

**Round 2** — F1/F2/F3 closed: 2 A-02 files removed via `git rm`; 76 new registry-driven tests added (Axis VM-A 38 types with decomposers + Axis VM-G 38 types pricing-unavailable, 61% registry-derived); deviation note added to story file at line 113. NEW HIGH finding: `--cost-detail` flag not registered in `PROBE_MANIFEST.yaml` or whitelist — `shipped-wired contract B` test FAILS.

**Round 3** — `--cost-detail` added to `PROBE_WHITELIST_FLAGS` at `shipped-wired-contract.test.ts:244` with inline justification comment citing Axes I/J/K coverage in plan.test.ts (whitelist per file's own docstring option (b) at lines 153-168 — runtime probe impractical without Bedrock creds).

## Independent verification (Round 3 reviewer)

- `shipped-wired-contract.test.ts` — 26/26 PASS (9.83s)
- `plan.test.ts` — 125/125 PASS (3.02s)
- `pnpm build` — FULL TURBO, 4/4 PASS
- Round-2 fixes preserved: no A-02 files in commit stat; 76 registry-driven tests retained (6 `enumerateTypes`/`defaultDecomposerRegistry` references intact).
- Primary cost source: `pricingBreakdown.fixedSubtotal` confirmed at `plan.ts:227-231`. `estimatedMonthlyCost` is fallback only.

## Verdict

ACCEPT.
