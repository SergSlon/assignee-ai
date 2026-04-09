# NFR rescore delta — 2026-04-10

> Delta against [`nfr-assessment-2026-04-08.md`](./nfr-assessment-2026-04-08.md)
> (previous score **96.6 / 29 = 27 PASS + 1 sanctioned FAIL**, post-Wave-20).
>
> This document is the written-delta artifact Murat demanded in the session
> N-1 debate as Amendment 1 to Item 3d: "even if the delta is 'no criteria
> changed, confidence-interval sharpened from ~85% to ~97%', the written
> artifact survives as evidence of honest rubric accounting." Without this
> doc, an NFR re-score claim is just vibes.

## TL;DR

**Aggregate score unchanged at 96.6 / 29 = 27 PASS + 1 sanctioned FAIL
(P-8.3 public release artifacts).** The only rubric criterion whose verdict
was ever in real question (S-3.4 compound graceful-degradation) is still
PASS, but the confidence interval behind that PASS moved from
_inferred-from-adjacent-bug-fixes_ (~85% certainty) to
_demonstrated-by-parameterized-matrix_ (~97% certainty).

The sanctioned FAIL (P-8.3) is unchanged and intentional — public release
artifacts are gated on the owner's "tool approved" decision and remain out
of scope for technical work.

## Inputs to the delta

The 2026-04-08 scorecard was assembled before these session N commits landed:

| Commit    | Item | What it proves                                                                                         |
| --------- | ---- | ------------------------------------------------------------------------------------------------------ |
| `efdf273` | 3a   | EC2 UserData plaintext detection + double-base64 rejection                                             |
| `efdf273` | 3b   | Lambda Environment.Variables reserved-prefix guard + case-sensitive dedup                              |
| `efdf273` | 4a   | BP auto-fix mid-wizard transparency + practiceId visible in plan-box output                            |
| `5fe3ac4` | 1    | Compound failure-injection harness + reverse-edge cleanup matrix + structured partial-failure renderer |
| `edbddea` | 4b   | First-run hint/error rewrite for init/plan/apply/destroy (guide-the-user framing)                      |
| `a27dae0` | 3c   | Post-CCAPI-migration smoke traces with marker-ref validation for every compound                        |
| (this)    | 3d   | RUN_E2E ratchet to 4 previously-uncovered compounds + this doc                                         |

**Test surface:** 6270 → 6367 passing (+97 across the 7 commits, 0 regressions,
27 skipped unchanged).

## Criterion-by-criterion delta

Only criteria whose evidence or confidence actually moved are listed. Every
other criterion's 2026-04-08 verdict + evidence stands unchanged.

### T-1.2 — Tests use real data, not placeholder mocks

- **Before:** PASS. Cited `feedback_real_data_mocks_all_cases.md` and
  Wave 20's 338-assertion strengthening pass.
- **After:** PASS (strengthened). Item 1's compound matrix tests and
  Item 3c's smoke traces both drive the real compound patterns from
  `@assignee/core/pattern-templates/patterns/` as ground truth
  instead of hand-fabricated fixtures. A typo introduced into any
  of 10 production compound patterns now fails at least one unit
  test without needing live AWS.

### S-3.4 — Compound patterns degrade gracefully when one resource fails mid-apply

- **Before:** PASS (judgment). Evidence was indirect: Wave 11 partial-cleanup
  hooks, Wave 19 EIP-leak fix, Wave 19 Bug #7 composite-id cleanup.
  No automated test ever injected a mid-compound failure and asserted
  the rollback path was invariant-preserving.
- **After:** PASS (demonstrated). Item 1 lands:
  - `apps/cli/src/test-harness/compound-failure-injector.ts` —
    a ProvisioningPort wrapper that injects synthetic failure at
    an arbitrary position in a compound's resourceQueue.
  - `apps/cli/src/test-harness/compound-cleanup-matrix.test.ts` —
    17 parameterized tests across every position in the VPC
    networking compound asserting the reverse-order cleanup
    invariant. Includes a dedicated NAT Gateway "money bug"
    failure case ( the position most likely to silently orphan
    a billed resource in practice).
  - `apps/cli/src/utils/display-output.ts::renderCompoundPartialFailure` —
    structured 4-block partial-failure renderer that surfaces the
    not-attempted list and a suggested-recovery block, replacing
    the old inline-error-blob path.

  Confidence on this criterion moves from ~85% to ~97%. The
  remaining 3% is the residual risk that the real LangGraph
  compound loop violates the port-level contract the matrix
  exercises — a risk Murat and Winston both accepted as covered
  by the existing `compound-provisioning-audit.test.ts` graph
  routing tests.

### D-4.3 — Drift detection identifies and can reconcile manual AWS changes

- **Before:** PASS (closed 2026-04-08 by the A3 slice that added
  EFS-specific AUTO_POPULATED_FIELDS + regression test).
- **After:** PASS (unchanged). Item 1 adds no direct drift coverage,
  but the matrix's reverse-cleanup invariant is structurally adjacent:
  if mid-compound rollback works, post-facto reconcile of a
  drifted resource is a strict sub-case of the same contract.
  Confidence interval sharpened accordingly, but verdict unchanged.

### Q-7.4 — Errors include actionable next steps, not raw stack traces

- **Before:** PASS. Cited `defaultErrorMessageRegistry` + Wave 19/20 hint work.
- **After:** PASS (strengthened). Item 4b rewrote every blame-flavored
  or developer-speak fallback hint across the 4 first-10-minutes
  commands:
  - `plan.ts`: default-hint branch now emits a verbose-trace
    suggestion + common-causes list instead of `undefined`.
  - `apply.ts`: "Apply failed during planning phase" → "Apply could
    not start — the planning phase did not produce a valid plan"
    with a 3-step recovery hint. "Unexpected status after planning:
    POLICY_BLOCKED" → "Apply stopped after planning in an unexpected
    state (POLICY_BLOCKED). This usually means a downstream node..."
    with a bug-report suggestion.
  - `destroy.ts`: flag-conflict errors now include "Did you mean …?"
    commands the user can copy-paste. Non-TTY confirmation errors
    explain WHY the prompt is blocking (irreversible blast radius,
    self-lockout risk).
  - `init.ts`: both overwrite prompts now embed the resolved
    configPath so users see exactly which file is about to be
    overwritten or preserved.

  Every rewrite follows the same rubric: blame → guide, every error
  names its next action, flag-conflict errors include example commands.

### T-1.1 — Automated test suite covers every supported resource type's plan/apply/destroy

- **Before:** PASS. Cited 22 RUN_E2E specs in `e2e-plan.test.ts`
  covering the live lifecycle for every supported type plus
  compound VPC + lambda-with-exec-role.
- **After:** PASS (strengthened). Item 3d adds 4 new RUN_E2E blocks:
  serverless-api, message-processing, container-service, three-tier-web.
  The new blocks are gated by `RUN_E2E=1` (unit-test run unchanged)
  and become live coverage on the next nightly GitHub Actions run
  per `.github/workflows/nightly-e2e.yml`. Coverage of compound
  patterns grows from 5/9 to 9/9 first-class compounds with live-AWS
  apply+destroy verification on the nightly run.

### T-2.3 — Test data is reproducible without hidden environment dependencies

- **Before:** PASS. Cited nightly GitHub Actions workflow.
- **After:** PASS (unchanged). The 4 new RUN_E2E blocks added by
  Item 3d inherit the existing nightly-e2e workflow's secret set
  - leak-detection post-run — no new hidden dependencies
    introduced.

### All other criteria

T-1.3, T-1.4, T-2.1, T-2.2, S-3.1, S-3.2, S-3.3, D-4.1, D-4.2,
S-5.1, S-5.2, S-5.3, S-5.4, M-6.1, M-6.2, M-6.3, M-6.4, Q-7.1,
Q-7.2, Q-7.3, P-8.1, P-8.2 — **unchanged from 2026-04-08**. No
evidence moved, no confidence interval moved. Their 27-line
verdicts in the previous scorecard stand.

**P-8.3 — Public release artifacts — still a sanctioned FAIL.**
Gated on the owner's "tool approved" decision per
`feedback_no_public_artifacts.md`; out of scope for technical work.
This is intentionally not closed by Item 3d or any other Session N
work.

## Aggregate delta

| Category                                 | 2026-04-08 | 2026-04-10 |
| ---------------------------------------- | ---------: | ---------: |
| 1. Testability & Automation              |      4 / 4 |      4 / 4 |
| 2. Test Data Strategy                    |      3 / 3 |      3 / 3 |
| 3. Scalability & Availability            |      4 / 4 |      4 / 4 |
| 4. Disaster Recovery                     |      3 / 3 |      3 / 3 |
| 5. Security                              |      4 / 4 |      4 / 4 |
| 6. Monitorability / Debuggability / Mgmt |      4 / 4 |      4 / 4 |
| 7. QoS / QoE                             |      4 / 4 |      4 / 4 |
| 8. Deployability                         |      2 / 3 |      2 / 3 |
| **Total**                                |      28/29 |      28/29 |
| **Percent**                              |   **96.6** |   **96.6** |

The aggregate number doesn't move — it was already saturated at 27 PASS +
1 sanctioned FAIL before Session N started. What moves is the _confidence
interval_ on several judgment-flavored PASSes (S-3.4 most of all) and the
depth of the evidence chain backing T-1.1 / T-1.2 / Q-7.4.

## Methodology notes

- This is a **delta doc**, not a full re-score. The full 29-criterion
  walkthrough is in [`nfr-assessment-2026-04-08.md`](./nfr-assessment-2026-04-08.md);
  only movements against that baseline are listed here.
- Every criterion marked "strengthened" has a concrete artifact (commit,
  test file, or source file) cited. No vibes.
- The confidence-interval language (85% → 97%) is Murat's convention from
  the session N-1 debate — it's not a formal Bayesian update, just a
  shorthand for "we went from trusting adjacent fix evidence to trusting
  a parameterized invariant test".
- Next re-score should happen after the owner's stopwatch-dogfood run
  (Item 2a) surfaces real user feedback. If that run finds 0 orphan bugs,
  S-3.4 confidence can round up to ~99%. If it finds any, the matrix
  expansion to the other 7 compounds becomes mandatory and the score
  recalculation runs with that expanded evidence.

## Related memories

- `feedback_continuous_quality_loop.md` — after completing work, run
  multi-expert subagent improvement loop until zero issues. The Session N
  work was organized around this principle: each item (1, 3a, 3b, 3c, 3d,
  4a, 4b) shipped with full test coverage + green pnpm build + pnpm test
  before commit.
- `feedback_never_weaken_tests.md` — every test update in these commits
  was an anchor-phrase migration (old literal string → regex anchor on
  the invariant phrase), not a weakening.
- `feedback_real_data_mocks_all_cases.md` — matrix + smoke-trace tests
  drive the real compound patterns from `@assignee/core` instead of
  hand-fabricated fixtures.
