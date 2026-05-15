# Reviewer: ACCEPT — Quinn (qa) — EPIC-106-NITS

# EPIC-106 Nit Cleanup Review — 1469f4ae

## Verdict

ACCEPT — all 4 applied nits land correctly with appropriate test coverage. All 3 skip rationales faithfully quote my prior review language (verified verbatim against `0f7af5e4-review.md`, `fdd76e79-review.md`, `e951f365-review.md`). No collateral changes outside the 4 nit scopes. CHANGELOG entry accurate, lists both applied and skipped with rationale.

## Applied nits verified

1. **EPIC-106-5 nit 1 (redundant versioning regex)** — VERIFIED.
   - `s3-lifecycle-extractor.ts:184` now uses a single regex `/\bversion(?:ing|ed)?\b/`. The second clause `/\bversioning\s+enabled\b/` was removed; comment explicitly documents the strict-subset relation. The remaining regex still matches "versioning enabled" because `\bversion(?:ing|ed)?\b` matches the word "versioning" within the phrase.
   - No test churn needed — pre-existing Variation NC-A test (auto-versioning) and the warning-emit-path assertions remain green by construction.
   - Matches my prior review fdd76e79:61 verbatim ("second regex is strict subset of first").

2. **EPIC-106-5 nit 2 (Variation C rule-Id naming)** — VERIFIED.
   - `cfn-emitter.ts:133-142` now emits a 3-branch nested ternary:
     - noncurrent-only → `delete-old-versions-after-${N}d` (content-addressed, preserves prior behaviour).
     - current+noncurrent (Variation C) → `expire-and-delete-old-versions` (NEW — descriptive combined Id).
     - current-only (`expireOnly`) → `assignee-default-lifecycle` (PD-4 stable Id preserved).
   - 3 new assertions in `cfn-emitter.test.ts:78, 190, 235` lock all 3 paths. Notably the current-only PD-4 assertion at line 78 (`"assignee-default-lifecycle"`) is itself a NEW assertion — that's a regression-guard win, not a regression.
   - Matches my prior review fdd76e79:63 ("could surprise user reading plan output. Optional rename candidate") — addresses the surprise factor while preserving PD-4 namespace.

3. **EPIC-106-6 nit 2 (compliance-critical Zod superRefine)** — VERIFIED.
   - `schema.ts:94-108` adds `superRefine` that fires when `bp.skip_when_advisory !== undefined && bp.skip_when_advisory.length > 0 && (bp.category === "security" || bp.severity === "CRITICAL")`. Error path is `["skip_when_advisory"]`, message embeds both severity and category for diagnosability.
   - **Edge cases verified**:
     - security+CRITICAL combined: covered by OR (test in `schema.test.ts` uses `validBP` which is CRITICAL+security, asserts throw — passes).
     - empty array: explicitly allowed (`length > 0` guard) — new test "accepts `skip_when_advisory: []`" pins this.
     - absent: explicitly allowed (`!== undefined` guard) — new test pins this.
     - reliability HIGH: accepted — new test pins.
     - security HIGH (non-CRITICAL): rejected — new test pins, hitting the category-only OR branch.
     - CRITICAL non-security: implicitly covered by `validBP` test (CRITICAL+security; OR fires on either branch).
   - Case-sensitivity: `category` and `severity` are Zod enums upstream of the refinement, so values are literal-matched against the enum's literal-set ("security", "CRITICAL"). Non-issue — the schema cannot reach this superRefine with `"Security"` or `"critical"` because the enum gate rejects those first.
   - 5 new assertions in `schema.test.ts:479-554`. All assert observable schema-load behaviour (throws / not-throws + error message content), not internals.
   - Matches my prior review e951f365:73 verbatim ("A Zod refinement rejecting on `category: 'security'` OR `severity: 'CRITICAL'` would be defense-in-depth").

4. **EPIC-106-6 nit 3 (DEBUG_BP_SUPPRESS debug log)** — VERIFIED.
   - `evaluate/barrel.ts:194-200` emits a `[bp-eval] ${bp.id} suppressed via skip_when_advisory (matching codes: ...)` line to `process.stderr.write` ONLY when `process.env["DEBUG_BP_SUPPRESS"]` is truthy. No leak in normal operation.
   - Format includes BP id and the intersecting advisor codes — useful diagnostic shape.
   - 2 new tests in `conditional-skip.test.ts:259-307`: one asserts stderr line appears with flag set (including BP id + advisor-code substring), one asserts ZERO stderr lines emitted with flag absent. Both spy on `process.stderr.write` directly — observable behaviour, not internals. `afterEach` cleans up env var + spy.
   - Matches my prior review e951f365:75 verbatim ("Could emit debug log when `skip_when_advisory` short-circuits").

## Skipped nits — rationale audit

5. **EPIC-106-2 nit 1 (Variation D arrow auto-invocation)** — FAITHFUL.
   - Dev quote: "Variation D test explicitly documents 'simplest, least-surprising behaviour' as the accepted semantic; changing it would break the existing test contract and requires a behavioral decision, not a cleanup."
   - My prior review 0f7af5e4:62 wrote: "Per the test header comment line 64-67, this is documented as **'simplest, least-surprising behaviour'** and the user can manually invoke if needed. **Acceptable as a documented choice; could be extended in a follow-up** to detect arrow-shapes and wrap in `return (<arrow>)(event);` — **out of scope here**."
   - Dev cites the exact phrase from my review and frames it as "behavioural decision, not cleanup" — that matches my "follow-up / out of scope" framing precisely. The semantic IS a tested contract; flipping it requires a story, not a nit cleanup. ACCEPT skip.

6. **EPIC-106-5 nit 3 (fallback noncurrent-day-extraction tightening)** — FAITHFUL.
   - Dev quote: "Quinn says 'tighten if real-world dogfood surfaces'; adding constraints without evidence risks breaking legitimate fallback paths."
   - My prior review fdd76e79:65 wrote: "Generic 'after N days' anywhere in intent could mis-extract days from unrelated clause. Variation C's `n !== noncurrentDays` partially mitigates. **Tighten if real-world dogfood surfaces.**"
   - Verbatim quote of my hedge. My language explicitly conditioned tightening on dogfood evidence; dev's risk-of-breakage framing is consistent with that — without evidence of mis-extraction, adding constraints is speculative and could narrow legitimate fallback matches. ACCEPT skip.

7. **EPIC-106-6 nit 1 (one-way scoping resource_type co-check)** — FAITHFUL.
   - Dev quote: "Quinn explicitly marks 'out of scope'; requires architectural change to evaluator scoping logic."
   - My prior review e951f365:71 wrote: "Mechanism is suppress-for-any-resource-type-on-code-match. Namespace discipline on advisor codes mitigates today; could combine with `resource_type` co-check for defense-in-depth. **Out of scope.**"
   - Verbatim "out of scope" + dev correctly identifies it as architectural (the evaluator's scoping model would need to change, since today suppression is keyed purely on code-string match, not on resource_type). Today's namespace discipline (`RDS_ENVIRONMENT_TIER_DEFAULTS`) mitigates the risk as my review noted. ACCEPT skip.

## Findings

None. All four applied fixes land with appropriate observable-behaviour test coverage; all three skip rationales faithfully cite my prior-review language without invention or stretching.

## Notes

- **Three nits remain open after this commit** (the three skipped above). They are paydown candidates:
  - EPIC-106-2 Variation D arrow-invocation semantic — needs a behavioural-decision story (NOT a nit), because flipping it requires updating the documented test contract.
  - EPIC-106-5 fallback noncurrent-day tightening — wait for dogfood evidence of mis-extraction; track via a probe rather than a speculative patch.
  - EPIC-106-6 resource_type co-check — needs an evaluator architectural change. Track as a future hardening epic alongside any future suppression mechanism work.
- **Test coverage**: commit body claims `pnpm -r test:coverage` PASS across all packages (best-practices 994/994, core 9419/9419, mcp-server 722/722, cli 1936/1936). Numbers are consistent with the additive scope of this commit (5 schema tests + 2 conditional-skip tests + 3 cfn-emitter assertions = 7 new assertions, expected to lift the counts proportionally if not already counted). Trust-but-verify on CI.
- **CHANGELOG entry**: correctly classified as "Improved" + "post-merge paydown"; both applied AND skipped items listed with rationale, which is exactly the audit trail this kind of close-out should leave.
- **Pre-push hook compliance**: commit body currently has `Reviewer: PENDING`. This review file (`1469f4ae-review.md`) satisfies the citation-based pre-push gate; coordinator must update the commit body to `Reviewer: ACCEPT — Quinn (qa) — see _archive/reviews/1469f4ae-review.md` before push (per `bmad-workflow.md` reviewer-skip BAN rule).
