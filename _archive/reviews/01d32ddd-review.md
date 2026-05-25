# Reviewer: ACCEPT — qa (Quinn) — F6-ITEM-2

**Commit:** 01d32ddd (amend of 45427772)
**Scope:** F6 closure — CloudFront baseline cost from CloudWatch + Pricing MCP (after FIX-REQUIRED amendment)
**Verdict:** ACCEPT — with two doc-consistency follow-ups
**One-line:** All four prior-review fixes (HIGH-1, HIGH-2, MED-1, bonus 3-tier test) landed correctly; the new multi-edge fixture is structured exactly as it should be to actually exercise the fix; only two new MED findings, both doc-stale text in the commit body / CHANGELOG that don't affect runtime behaviour.

## Strengths

- HIGH-1 fix is properly factored: new `PricingField.FROM_LOCATION` constant + new `PricingFilterValue.FROM_LOCATION_NORTH_AMERICA` constant + new filter entry on the decomposer's data-transfer line item + corresponding documentation rationale in both files. Code reads cleanly and matches the codebase's existing filter-constant convention.
- The new `CLOUDFRONT_DATA_TRANSFER_MULTI_EDGE_REGION_RESPONSE` fixture is adversarial-quality: JP first, SG second, NA last. A regression that drops the `fromLocation` filter (or breaks `itemMatchesFilters`) would land on JP's $0.114/GB → `$11.41/mo`, NOT NA's $0.085/GB → `$8.51/mo`. The assertion `expect(result.get(arn)).toBe("$8.51/mo")` is the tight numerical lock; no fuzzy regex shortcuts.
- HIGH-2 fix is minimal and correct: new `PriceUnit.PER_REQ = "/req"` constant, CloudFront decomposer uses it, F6 promotion path unchanged (suffix-stripping regex `replace(/\/.*$/, "")` is unit-agnostic — handles `/req`, `/10K reqs`, `/M reqs` equivalently). Doc comment block at the prior production code site was replaced with a one-line invariant ("CloudFront requests are per-request; rate × raw count = monthly cost") — sheepish-confession vibe is gone.
- MED-1 fix is exactly right: the false `/ 10_000` claim in the fixture docstring is replaced with the honest "uses the raw rate (per-1-request) directly". Future readers won't be misled.
- Bonus 3-tier-crossing test (61,440 GB → $4761.60) closes the bottom-tier-branch coverage gap. Math walks out cleanly: 10240×$0.085 + 40960×$0.080 + 10240×$0.060 = $870.40 + $3276.80 + $614.40 = $4761.60 ✓.
- KMS / SSM / SecretsManager decomposers correctly untouched (verified via `git show --stat` — zero diff in those paths).
- `_backlog/per-10k-reqs-display-bug-other-services.md` is properly written: cross-references the prior review (`45427772-review.md` HIGH-2), names the three affected files with line numbers, prescribes the minimal fix, calls out the F6 promotion path's existing tolerance, estimates ~30 min effort + Quinn review.
- Commit body's "Amended after Quinn FIX-REQUIRED:" block is concise and faithful to what changed.
- `pnpm -r test:coverage` independently confirms **13,737 passed** (994 + 9963 + 722 + 2058) — matches author's report exactly. +2 vs prior 13,735 = the multi-edge test + the 3-tier-crossing test, as advertised.

## Findings

### BLOCKER (must fix before merge)

- none

### HIGH (should fix before merge)

- none

### MED (should address in follow-up)

- **Commit body and CHANGELOG carry stale "PriceClass defaults to PriceClass_All (conservative-high estimate)" prose.** The commit body's main paragraph (and the corresponding CHANGELOG bullet) still describe the pre-amendment world where PriceClass was claimed as the rate-selection knob. After this amend the actual mechanism is `fromLocation=North America` filter — and the PriceClass dead-code path was deleted from `buildMinimalDesiredState`. Two readers' impact:
  1. Anyone reading `git log --oneline | head -1 | xargs git show` looking for "what changed and why" gets a misleading explanation that doesn't match the code.
  2. `CHANGELOG.md` ships to users; "PriceClass defaults to PriceClass_All (conservative-high estimate)" is incorrect and will confuse operators who diff their bill against the displayed `$X.XX/mo`.

  Recommended text for both: "Data-transfer rate pinned to the North America edge baseline ($0.085/GB tier 1); deterministic across runs. PriceClass-aware per-edge selection (which would let Singapore-edge-heavy distributions display the higher $0.120/GB rate) is deferred to F6-followup — requires an extra `cloudfront:GetDistributionConfig` call per distribution."

  Also: the commit-body says "13 new tests" but the amend added 2 more (multi-edge regression test + 3-tier-crossing math test) → should read "15 new tests". Either amend the commit body OR drop the parenthetical count and let `_archive/reviews/` carry the receipts.

- **Permissive-filter contract leaves a latent gap on `fromLocation`-missing entries.** `itemMatchesFilters` (`packages/core/src/pricing/mcp-parser.ts:109-122`) explicitly documents "Missing attributes or missing key = cannot validate, let it pass." Real AmazonCloudFront `productFamily=Data Transfer` rows always carry `fromLocation`, but if AWS ever returns a sparse-attributes aggregate row (or a future Pricing API shape change drops the attribute), the filter would silently pass non-NA entries through and the F6 promotion would revert to non-deterministic. Add a defensive fixture: a fourth entry with `attributes: {}` first in the array; assert the test still picks NA (the entry without `fromLocation` should NOT be selected over the explicit-NA entry, OR if it IS picked, the test would catch it via a wrong $/mo). Effort: ~10 LoC. Severity: LOW-MED because the actual AWS Pricing API has not produced this shape in CloudFront responses historically.

- **(carried-forward from prior review, still unaddressed)** No IAM-policy regression test for the namespace-array shape (`packages/core/src/config/iam-policies/operator.ts:235`). Same severity as before — MED, not upgraded. The widening from single-string to two-element array is exactly the kind of change a snapshot test should lock down, and grep confirms zero references to `CloudWatchStorageMetricsRead` outside the policy file itself.

- **(carried-forward)** No `it.todo` marker documenting the PriceClass-aware deferral. Effort: 1 LoC. Visibility win: future contributors see the gap in `pnpm test` output.

- **(carried-forward)** No partial-success CloudWatch test (one of the two CloudFront metric calls returns empty datapoints while the other has data). Current coverage handles "throws" but not "empty datapoints in just one of the pair."

### LOW / nit (optional)

- The `enrichCloudFrontGroup` opening docstring (`pricing-enricher.ts` near line 686 in the amend) now describes the NA-edge limitation honestly ("distributions deployed with `PriceClass_All` that route significant traffic through SG / HK / JP edges ($0.110–0.120/GB) under-cost by up to ~41%") — that's the right tone, but the analogous CHANGELOG line still claims "conservative-high estimate" which is the OLD framing. Same root cause as MED-1 above; mentioning it as a nit because it's also visible in the `CHANGELOG.md` user-facing surface.
- `_backlog/per-10k-reqs-display-bug-other-services.md` could cite the new `PriceUnit.PER_REQ` constant by name as the recommended replacement (right now it says "change `priceUnit` to `\"/req\"`" — naming the constant would prevent a future copy-paste fix that hardcodes the literal again).

## Author's self-flagged concerns — verdict on each

(The four prior-review fixes, re-verified.)

1. **HIGH-1 (PriceClass / non-determinism) — FIXED CORRECTLY.** Confirmed:
   - Filter is exactly `Field: "fromLocation", Value: "North America"` (not "NA", not "us-east-1") — matches the canonical AWS Pricing API attribute value.
   - Wired via `PricingFilterValue.FROM_LOCATION_NORTH_AMERICA` constant in `pricing-filter-values.ts:23`. New `PricingField.FROM_LOCATION` constant in `filter-constants.ts:33`.
   - `itemMatchesFilters` call chain walks: not-productFamily → attribute-lookup → case-insensitive key match → `attributeValueMatches("Japan", "North America")` returns false → item filtered out. End-to-end works.
   - PriceClass dead code is genuinely gone: `buildMinimalDesiredState` returns `{}` for CloudFront (replaced switch case with an explanatory comment). Docstring on `enrichCloudFrontGroup` rewritten to describe the actual NA-edge baseline.
   - The multi-edge fixture (JP/SG/NA order) is correctly adversarial — passing this test definitively proves the filter is doing the work, not just first-item-wins.

2. **HIGH-2 (`/10K reqs` label) — FIXED CORRECTLY for CloudFront.** Confirmed:
   - New `PriceUnit.PER_REQ = "/req"` constant lives in `price-units.ts:41` with a clear doc-comment explaining the why.
   - CloudFront decomposer's request line emits `priceUnit: PriceUnit.PER_REQ` (was `PER_10K_REQS`).
   - F6 promotion path's regex-strip `replace(/\/.*$/, "")` is unit-agnostic — `$0.0000010000/req` parses to `0.000001` exactly as before. No code change needed in `pricing-enricher.ts` apart from the inline comment cleanup.
   - Grep on the codebase confirms no other consumer hardcoded `"/10K reqs"` expectation for CloudFront — only KMS/SSM/SecretsManager decomposers still use `PER_10K_REQS`, and they're tracked in the new backlog file.

3. **MED-1 (stale fixture docstring) — FIXED CORRECTLY.** The block comment at `pricing-enricher.test.ts:117-120` now reads "The pricing-enricher uses the raw rate (per-1-request) directly — fixture matches `priceUnit: '/req'` set in the CloudFront decomposer after F6-ITEM-2 amendment." No residual `/10_000` lies in the test file.

4. **Bonus 3-tier-crossing test — LANDED CORRECTLY.** `it("crosses 3 tiers correctly (61440 GB → $4761.60)")` at the `computeTieredCost` describe block. Math verified by hand: tier-1 cap 10240 × $0.085 = $870.40, tier-2 cap 40960 × $0.080 = $3276.80, tier-3 portion 10240 × $0.060 = $614.40, total $4761.60. Assertion uses `toBeCloseTo(4761.6, 4)` which is appropriately tight.

## Additional verification

- **KMS / SSM / SecretsManager untouched** ✓ — `git show --stat 01d32ddd | grep -E "kms-key|ssm|secretsmanager"` returns empty.
- **Backlog file created** ✓ — `_backlog/per-10k-reqs-display-bug-other-services.md` exists, cross-references `45427772-review.md` HIGH-2, names the three files+lines, prescribes the fix.
- **Commit body Reviewer line** ✓ — reads `Reviewer: PENDING — qa (Quinn) — F6-ITEM-2 — coordinator re-dispatches after this amend`. Correct format; PENDING (not ACCEPT) was the right state for the author to land for this re-review.
- **`pnpm -r test:coverage`** ✓ — 994 + 9963 + 722 + 2058 = 13,737 passed. Matches author's report exactly. Zero failures across all four packages.
- **No new HIGH or BLOCKER findings introduced by the amend** — the only new findings are MED doc-staleness in the commit body / CHANGELOG (both fixable as part of the ACCEPT amend if the author wants to land a clean record).

## Recommendation

**Amend-with-ACCEPT-citation-and-push.** The four code fixes are correct, the test coverage is genuinely tightened by the multi-edge adversarial fixture, and there are no behavioural defects remaining. Two small doc-text touch-ups (commit body and CHANGELOG "PriceClass defaults to PriceClass_All" → "fromLocation pinned to North America"; test count 13→15) would be ideal to land in the same amend so the historical record is consistent — but they don't block ACCEPT. The carried-forward MEDs (IAM-snapshot test, `it.todo` for PriceClass deferral, partial-success CloudWatch test) are appropriate for a small follow-up commit or a backlog entry alongside `_backlog/per-10k-reqs-display-bug-other-services.md`.

The pattern this amend establishes — non-deterministic rate-selection found, deterministic fix landed with an adversarial fixture that actually proves the fix — is exactly the kind of regression discipline that should propagate to the KMS/SSM/SecretsManager follow-up. Solid work.

**Ready for `Reviewer: ACCEPT — qa (Quinn) — F6-ITEM-2 — see _archive/reviews/01d32ddd-review.md` citation in the final amend.**
