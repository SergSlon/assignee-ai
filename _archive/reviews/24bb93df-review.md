# Reviewer: ACCEPT — Quinn (qa) — EPIC-106-SNS

# EPIC-106 SNS Decomposer Filter Review — 24bb93df

## Verdict

ACCEPT — structural fix lands cleanly. Publishes line is fully verified
against the mock fixture (productFamily=API Request + group=SNS-Requests-Tier1
match exactly between filter and fixture data). HTTP line uses the correct
structural shape (group instead of region-prefixed usagetype), eliminating the
same zero-match bug class as EPIC-106-8 (S3 PUT/GET). The specific group
string `SNS-HTTP` is dev's best-guess (live AWS Pricing MCP auth blocked at
time of fix); accepted with a logged follow-up to validate once live access
is restored. Mock fixture is internally consistent so the decomposer →
fixture round-trip is testable in CI even if the production string later
needs adjusting.

## Closure criteria verified

1. **Publishes filter matches mock fixture input** — VERIFIED.
   `packages/core/src/pricing/decomposers/sns.ts:52-56` filters on
   `F.PRODUCT_FAMILY = PF.API_REQUEST` + `F.GROUP = FV.SNS_REQUESTS_TIER1`.
   Fixture at `packages/core/src/test-fixtures/mcp-mock-responses/pricing-sns.ts:6`
   declares input `[productFamily=API Request, group=SNS-Requests-Tier1]` and
   data block sets `productFamily: "API Request"` + `group: "SNS-Requests-Tier1"` +
   region-prefixed `usagetype: "USE1-Requests-Tier1"` — exact match.

2. **HTTP filter uses `group` not `usagetype`** — VERIFIED.
   `sns.ts:79-89` filters on `F.PRODUCT_FAMILY = PF.MESSAGE_DELIVERY` +
   `F.GROUP = FV.SNS_DELIVERY_ATTEMPTS_HTTP`. No `usagetype` filter remains.
   Structural fix correct regardless of specific string value.

3. **EPIC-106-SNS fix-comment blocks** — VERIFIED.
   Two comment blocks at `sns.ts:39-48` (Publishes) and `sns.ts:65-74`
   (HTTP notifications). Both:
   - Cross-reference EPIC-106-8 S3 PUT/GET fix pattern
   - Explain the real API response shape (region-prefixed usagetype,
     stable group attribute)
   - Justify the chosen attribute (`group` over `usagetype`)
     Comment-block prose is precise and modeled on the S3 fix template.

4. **New FV constants exported and consumed** — VERIFIED.
   `pricing-filter-values.ts:67-68` adds `SNS_REQUESTS_TIER1: "SNS-Requests-Tier1"`
   and `SNS_DELIVERY_ATTEMPTS_HTTP: "SNS-HTTP"` (object literal `as const`,
   so exported automatically via the `PricingFilterValue` barrel). Each is
   referenced exactly once in `sns.ts` (lines 54, 85). No typos, no orphan
   from this commit.

5. **Mock fixture consistent with new filter shape** — VERIFIED.
   `pricing-sns.ts:6` declares input filters identical to what the
   decomposer sends. New `snsHttpDelivery` fixture at line 56 has
   `productFamily: "Message Delivery"` + `group: "SNS-HTTP"` +
   `usagetype: "USE1-DeliveryAttempts-HTTP"` (region-prefixed —
   demonstrates the bug condition the fix addresses).

6. **Tests assert filter shape + fixture parity** — VERIFIED.
   `sns.test.ts:91-122` adds 4 tests:
   - Publishes line filter shape (positive + negative assertions —
     blocks `Message Delivery` and any `usagetype` filter)
   - HTTP filter shape (positive `group` + negative `usagetype`)
   - Publishes mock fixture parity (productFamily + group)
   - HTTP fixture parity (productFamily + group + region-prefixed usagetype)
     Drift between decomposer and fixture will trip both the shape test
     AND the parity test — defensive in depth.

7. **No collateral damage** — VERIFIED. Diff stat is 4 files, all
   SNS-scoped (`sns.ts`, `sns.test.ts`, `pricing-sns.ts`, additive
   `pricing-filter-values.ts` entries with safe comment block). No
   touches to other decomposers, no shared barrel mutations.

8. **HTTP group-value confidence** — UNVERIFIED (live API blocked).
   Documented below in Notes. Accepting structurally; specific string
   to be re-validated post-live-access.

## Findings

- **LOW: orphan legacy FV constant** —
  `packages/core/src/pricing/pricing-filter-values.ts:61` —
  `DELIVERY_ATTEMPTS_HTTP: "DeliveryAttempts-HTTP"` now has zero consumers
  (full repo grep returns no `FV.DELIVERY_ATTEMPTS_HTTP` references; only
  the new `SNS_DELIVERY_ATTEMPTS_HTTP` is used in `sns.ts:85`).
  — Fix: delete the orphan in a follow-up sweep, or keep as a documented
  "real-API unprefixed form, kept for future re-investigation" reference.
  Not blocking; pure tidy-up.

## Notes

- **HTTP group value `SNS-HTTP` confidence: ACCEPT-WITH-FOLLOWUP.**
  Dev flagged this as best-guess; the live AWS Pricing MCP returned an
  auth error (security token invalid) when both dev and coordinator
  tried to verify. Group-naming pattern (`SNS-Requests-Tier1`,
  `S3-API-Tier1/Tier2`) suggests `SNS-HTTP` is plausible but a value
  such as `SNS-DeliveryAttempts-HTTP` or `SNS-HTTPDeliveryAttempts`
  cannot be ruled out without a live API response.

- **Why structural fix is acceptable to merge now:**
  Before the fix, HTTP delivery returned zero matches in production
  (region-prefixed usagetype filter against unprefixed value).
  Post-fix, if `SNS-HTTP` is correct, behaviour is fixed. If `SNS-HTTP`
  is wrong, behaviour stays at zero-match (the EXISTING broken state)
  until the string is corrected — no regression.

- **Follow-up paydown (for the next session with restored AWS Pricing
  MCP access):**
  1. Call `aws-pricing.get_pricing` with `service_code=AmazonSNS`,
     `region=us-east-1`, and a `productFamily=Message Delivery` filter
     (no group restriction) to enumerate all delivery-attempt SKUs
     and observe the actual `group` attribute on each.
  2. If observed value differs from `SNS-HTTP`, update:
     `pricing-filter-values.ts` (`SNS_DELIVERY_ATTEMPTS_HTTP`),
     `pricing-sns.ts` (`snsHttpDelivery.success.text` `group` field),
     and (if used in a string-literal assertion) the test at
     `sns.test.ts:101-105` and `sns.test.ts:122`. No decomposer or
     fixture-shape changes needed — the bug is hard-coded in two
     places (constant + mock).
  3. Also verify `SNS-Requests-Tier1` for the Publishes line against
     a live call for completeness; the mock fixture already declares
     it but a live confirmation closes the loop.
  4. Sweep the orphan `DELIVERY_ATTEMPTS_HTTP` FV constant (Finding
     above) at the same time.

- **No reviewer-skip token in the original commit body** —
  commit body says `Reviewer: PENDING — qa (Quinn) — review pending`,
  which is what this review file resolves. The pre-push hook expects
  one of `Reviewer: ACCEPT`, `Reviewer: SKIP — ...`, or a citation
  to this very file (`_archive/reviews/24bb93df-review.md`). The
  file path is the canonical citation form; future commit on this
  branch should either amend the body or add a follow-up commit
  referencing this review.
