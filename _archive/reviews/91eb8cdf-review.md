# Reviewer: ACCEPT — qa (Quinn) — F6-ITEM-1

**Commit:** 91eb8cdf
**Scope:** F6 closure — prefix-aware Pricing-MCP matcher for S3 non-Standard storage classes (single-class) + L7 fixture assertion flip.
**Verdict:** ACCEPT
**One-line:** Tight, conservative matcher fix with the right test surface; no regressions across all 13713 tests; doc split is accurate; no false-positive risk observable from the current decomposer filter inventory.

## Strengths

- The regex `^[A-Z0-9]+-` is the narrowest possible expression of "AWS region-prefix on a usagetype" — it excludes the most common lookalikes (`BoxUsage:t3.large`, `gp3`, `MyValue-attr`, `mycompany-foo`) and the call-site only consults it when exact-equality first fails. That belt-and-braces ordering is exactly the right risk posture for a backstop comparator.
- The fix is localised: one new pure function (`attributeValueMatches`, 11 LOC + docstring), one call-site change (`itemMatchesFilters` line 116-119), and a docstring-only update on the existing fixture. No barrel/import shuffles, no semantic change to `extractFirstTierPrice` / `extractTieredPrice`.
- The regex is hoisted to a module-level const (single compile) and named `PRICING_API_PREFIX_RE` so future readers can grep for usage. Comment block above it lists five concrete real-world examples + four explicit non-match cases — best-in-class documentation density for a 1-line regex.
- The L7 test flips from a deliberately-buggy assertion (`toBeUndefined()`) to the production-correct value (`$2.30/mo`). Pricing math is verifiable end-to-end: fixture USD `0.0230000000`, storageEnricher reports 100 GB, `pricing-enricher.ts:557` multiplies `ratePerUnit * storageGB = 0.023 * 100 = 2.30`, and `formatCostLabel` emits `$2.30/mo`. The TODO that previously documented the buggy state is removed in the same commit — no dangling artifacts.
- The 4 new prefix-strip tests cover the three real fixture cases (SIA / GIR / INT-FA) plus a negative control with three sub-asserts (`mycompany-foo` reject, `foo` exact match, `MyValue-attr` partial-caps reject).

## Findings

### BLOCKER (must fix before merge)

- none.

### HIGH (should fix before merge)

- none.

### MED (should address in follow-up)

- **Chained prefix not handled despite docstring claim.** `mcp-parser.ts:41` says "_a short ALL-CAPS-DIGITS-HYPHEN token (**or a chain of such tokens**)_" but the regex strips ONE token only. If AWS ever returns a chained value like `USE1-CB-TimedStorage-ByteHrs` (e.g. cross-border or class-overlay variants), the strip yields `CB-TimedStorage-ByteHrs` and the equality check still fails. The line 63-66 comment correctly acknowledges "**One strip is sufficient for every observed real-world case**" — but the line 41 docstring claim contradicts that. Either (a) update line 41 to say "a single short ALL-CAPS-DIGITS-HYPHEN token" and drop "(or a chain of such tokens)", or (b) iterate the strip in a `while` loop (still safe because each iteration removes ≥ 2 chars so it terminates fast). I'd take (a) — it's a doc fix, no code risk. **Severity MED, not HIGH**, because no real-world AWS endpoint chains today.

### LOW / nit (optional)

- The negative-control test bundles three asserts under one `it()` (`expect(attributeValueMatches("mycompany-foo", "foo")).toBe(false)`, then `("foo", "foo")` true, then `("MyValue-attr", "attr")` false). Splitting into three discrete `it()` blocks would surface a clearer failure message if any one of them ever drifts. Cosmetic only — current shape passes and is easy to read.
- The fixture docstring still describes the matcher behaviour in past-tense-with-current-state (`"matched the stored ... filter"`). Fine as-is; if a future reader is doing test archaeology they'll understand the F6 closure context.

## Test coverage analysis

- The four new unit tests for `attributeValueMatches` are the right shape (positive direction = strip succeeds; one negative = strip refuses to fire). They lock the three S3 storage-class API shapes documented in real AWS responses + a control.
- **Suggested coverage gap (LOW priority follow-up):** there's no unit test for the _exact-match wins first_ branch (e.g. `attributeValueMatches("TimedStorage-ByteHrs", "TimedStorage-ByteHrs")` → true without needing the strip). The negative-control includes `("foo", "foo") → true` which is functionally equivalent but doesn't reach a value the regex would also pattern-match. A test like `attributeValueMatches("S3-API-Tier1", "S3-API-Tier1") → true` would lock the exact-match short-circuit explicitly (today's group-attribute case where API never prefixes).
- The L7 production-shape integration test fires the real `itemMatchesFilters` path end-to-end with the prefixed `usagetype: "USE1-TimedStorage-ByteHrs"`, so the integration surface IS covered. No need for a separate integration test for SIA/GIR/INT-FA — those are unit-level only — but if a future commit adds new prefix-tolerant call-sites, those should each gain their own integration probe.
- Reverse direction (filter value prefixed, API value bare) is intentionally NOT tested because decomposers store canonical un-prefixed values. Verified by grep across `packages/core/src/pricing/`: only `ssm.ts` line 55/79 stores values that look like prefix candidates (`ParameterStorage-Advanced-Tier1`, `PS-GetParameter-Transactions-Tier1`) and those are the canonical stored form — the API returns them either bare or region-prefixed, both of which the matcher handles correctly.

## Doc consistency

- `_backlog/wizard-ux-audit-2026-05-22.md` F6 section now has three blocks: (a) the original "Partial closure (2026-05-24)" for the storage-enricher wiring, (b) the new "Closed (this commit — F6 follow-up, prefix-aware matcher)" for the single-class non-Standard fix, and (c) "Out of scope for this iteration" listing CloudFront baseline + multi-class lifecycle-tiered S3. The split is clean and the closed-block explicitly cites both the source file (`mcp-parser.ts`) and the L7 test file path.
- The "Out of scope" CloudFront entry is unchanged in intent and remains accurate (CloudFront still needs a separate enricher; operator IAM policy is still `AWS/S3`-scoped only). The multi-class entry was correctly _expanded_ (not flipped to closed) to clarify that the prefix-aware matcher fixes single-class only; lifecycle-tiered buckets still need per-class `GetMetricStatistics` fan-out. Neither paragraph accidentally claims CloudFront or multi-class is fixed.

## Recommendation

**ACCEPT** as a clean single-commit closure of the single-class non-Standard S3 F6 path. The matcher is correctly scoped, the tests lock the right behaviour, the L7 dollar math (`100 GB × $0.023 = $2.30/mo`) verifies end-to-end through `extractFirstTierPrice` → `parsedRate` → `perResourceFixedSubtotal` → `formatCostLabel`, and the audit doc accurately demarcates what closed vs what stays deferred. The full `pnpm -r test:coverage` gate passes (13713 / 13713 tests, matching the agent's self-report exactly across all four packages: best-practices 994, core 9939, mcp-server 722, cli 2058).

The MED finding (docstring overclaim re: "chain of such tokens") is a 1-line edit — fold into the next pricing-decomposer commit alongside any prefix-related follow-up, or amend now if convenient. **Not a merge blocker.**

The coordinator should: **(a) amend the commit to add this review-file citation in the body, then push.** No fixup commit needed (the MED finding is doc-only and can ride a future commit). The 4 new tests, the L7 flip, and the audit-doc split are all production-ready.
