# Reviewer: ACCEPT — qa (Quinn) — EPIC-106-6

**Commit (pre-amend)**: `e951f365` — fix(best-practices): tier-gated BP-RDS rule suppression for staging/dev
**Base**: pre-EPIC-106-3 main; coordinator will rebase
**Story**: `_bmad-output/implementation-artifacts/epic-106-6-staging-tier-bp-rds-suppress.md`

## Gate-criteria verification

1. **Closure 1 — staging suppression** — `skip_when_advisory: [RDS_ENVIRONMENT_TIER_DEFAULTS]` added to BP-RDS-003 (MultiAZ FSBP), BP-RDS-004 (DeletionProtection), BP-RDS-011 (PerformanceInsights), BP-RDS-014 (TA single-AZ MultiAZ). Implemented via Option A (suppression, not demotion) — simpler. ✓

2. **Closure 2 — production preserved** — Variation B tests confirm both MultiAZ and DeletionProtection rules fire HIGH for `"for production"` intents (no `RDS_ENVIRONMENT_TIER_DEFAULTS` advisor). Pre-existing BP-RDS production-tier test files NOT touched. ✓

3. **Closure 3 — contextual suppression keyed by advisor** — `evaluate/barrel.ts:191-201` gates on `bp.skip_when_advisory.some(code => context.advisorCodes!.includes(code))` with length guards on both arrays. Cannot suppress except when matching code present. Variation C's `"SOME_OTHER_ADVISOR"` test confirms unrelated codes don't false-trigger. ✓

4. **Closure 4 — ≥4 variations covered** — 11 tests across 4 variations (A staging+advisory 3 sub-tests, B production no-advisory 2, C no-advisor-context 3, D compliance-rules preserved 3). ✓

## Adversarial checks

- **Compliance rules NOT tagged** — `grep -l skip_when_advisory packages/best-practices/rds/*.yaml` returns exactly 4 files: 003, 004, 011, 014. BP-RDS-001 (public access CRITICAL), BP-RDS-002 (encryption CRITICAL), BP-RDS-008 (IAM auth HIGH), BP-RDS-010 (CVE patches HIGH) NOT tagged → fire on staging regardless. Variation D verifies. ✓

- **Code-name collision risk** — Mechanism keyed by advisory code STRING. Namespaced code (`RDS_ENVIRONMENT_TIER_DEFAULTS`) only emitted by SX-4. Spec line 23 endorses this. Variation C's unrelated-code test confirms no false-trigger. ✓

- **Evaluator gate placement** — Runs after `check_type === "awareness"` gate, before evaluation work. Length-guarded on both fields. `any-match` semantics correct. ✓

- **Orchestrator wiring** — Single-line `advisorCodes: state.advisories?.map((a) => a.code)`. `?.` chain handles undefined; evaluator gate handles empty array. ✓

- **Schema additive** — `bestPracticeSchema` gets optional field; existing YAML rules without it continue to parse. ✓

- **Manifest regeneration** — Top-level + 4 modified rule hashes updated; other 137 unchanged. ✓

- **Stale spec anchor** — Story spec named "BP-RDS-006.yaml" but actual MultiAZ rule is BP-RDS-003. Dev correctly identified live file. Not a defect. ✓

## Test-weakening check

- `git diff` outside conditional-skip.test.ts: ZERO test changes.
- conditional-skip.test.ts: purely additive (NEW file, 251 LOC, 11 tests).
- Zero `it.skip`/`xit`/`describe.skip` introduced.
- 987 pre-existing BP tests still pass.
- **No test weakening.** ✓

## File-ownership verification

- types.ts (+11) ✓
- schema.ts (+1) ✓
- evaluate/barrel.ts (+13) ✓
- evaluate/context-builder.ts (+8) ✓
- BP-RDS-003.yaml, BP-RDS-004.yaml, BP-RDS-011.yaml, BP-RDS-014.yaml (+2 each) ✓
- manifest.json (+12/-6 — hash regen) ✓
- conditional-skip.test.ts (+251 NEW) ✓
- packages/core/src/graph/nodes/bp-evaluator/orchestrator.ts (+1) ✓
- CHANGELOG.md (+13) ✓

## Build + tests

- `pnpm build`: green (FULL TURBO).
- BP package: 987/987 in 1.43s.
- core BP-evaluator + SX-4 extractor: 52/52 in 3.17s.
- No live AWS, no new deps, no test weakening.

## Architectural soundness

`skip_when_advisory` mechanism is well-designed:

- **Declarative** (YAML, not code) — adding new tier-aware suppressions doesn't require evaluator changes.
- **Compliance-safe by default** — rules without the field fire unconditionally; opt-in.
- **Auditable** — each YAML rule explicitly lists accepted override codes.
- **Composable** — future rules could list multiple advisor codes.

## Informational nits (non-blocking)

1. **One-way scoping** — Mechanism is suppress-for-any-resource-type-on-code-match. Namespace discipline on advisor codes mitigates today; could combine with `resource_type` co-check for defense-in-depth. Out of scope.

2. **Compliance-critical-rule schema guard** — Convention/review currently enforces "no skip_when_advisory on encryption/network". A Zod refinement rejecting on `category: "security"` OR `severity: "CRITICAL"` would be defense-in-depth.

3. **Suppression visibility** — When suppressed, currently silent. Could emit debug log when `skip_when_advisory` short-circuits.

## Verdict

ACCEPT — well-designed YAML-driven suppression that closes a real user-visible contradiction without compromising compliance posture. All 4 closure criteria met, 11/11 new tests across 4 variations pass, 987/987 BP tests + 52/52 broader integration pass with zero test weakening. Compliance-critical rule exclusion (encryption, public access, IAM auth, CVE patches) provably preserved.
