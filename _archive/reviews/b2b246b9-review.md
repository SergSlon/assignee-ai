# Reviewer: REJECT — Quinn (qa) — EPIC-106-STRATEGIES

# EPIC-106 Strategies Cost-Label Review — b2b246b9

## Verdict

**REJECT** — the follow-on closes the 5 sites named in the brief but
LEAVES A 6TH strategy (`strategies/sqs.ts:34`) emitting the exact same
`/million requests` drift via `PriceUnit.PER_MILLION_REQUESTS_LONG`,
AND the new guard test does not import SQS — so the guard cannot catch
this regression in the future either. Per project rule
`feedback_fix_all_issues` ("NEVER defer issues as pre-existing — all
issues in the project must be fixed"), shipping a "centralise the
strategies layer" follow-on with one strategy still using the old
constant is a partial fix that re-opens the very class of drift the
EPIC-106-9 review flagged.

## Closure criteria verified

1. **All original sites fixed** — PARTIAL.
   - `strategies/dynamodb.ts:65` → `PriceUnit.PER_MILLION_WRITE_REQS`
     (renders `/M write reqs`). OK.
   - `strategies/sns.ts:32` → `PriceUnit.PER_MILLION_PUBLISHES`
     (renders `/M publishes`). OK.
   - `strategies/apigatewayv2.ts:59` → `PriceUnit.PER_MILLION_MESSAGES`
     (renders `/M messages`). OK.
   - `strategies/apigatewayv2.ts:75` → `PriceUnit.PER_MILLION_REQUESTS`
     (renders `/M requests`). OK — and this is the site the brief
     listed as "4th + HTTP path", confirmed fixed.
   - `strategies/lambda.ts:27` → `${formatUnitSuffix("request")}` inline
     in template literal (renders `/M requests`). OK.
   - **MISSED**: `strategies/sqs.ts:34` STILL emits
     `PriceUnit.PER_MILLION_REQUESTS_LONG` = `/million requests`. This
     site was not in the brief's "5 sites" list but is the same class
     of drift and is left untouched on the strategies layer that the
     follow-on claims to centralise. Evidence:
     `git grep "PER_MILLION_REQUESTS_LONG" -- packages/` returns
     `packages/core/src/pricing/price-units.ts:38` (definition) +
     `packages/core/src/pricing/strategies/sqs.ts:34` (live use).

2. **No dead code** — OK in the narrow sense.
   `PER_MILLION_REQUESTS_LONG` is still referenced by `sqs.ts:34`, so
   removing it would break SQS. BUT the _reason_ it survives is finding
   #1 above — SQS should be migrated to a canonical constant
   (`PER_MILLION_REQUESTS` = `/M requests`), at which point
   `PER_MILLION_REQUESTS_LONG` becomes dead and should be removed.
   Current state: superficially OK, but only because SQS was missed.

3. **Helper reuse** — OK. Strategies use `PriceUnit.PER_MILLION_*`
   constants which are derived from `formatUnitSuffix` in
   `price-units.ts:21-28`. Lambda uses `formatUnitSuffix("request")`
   directly in a template literal — appropriate since the surrounding
   template needs the `~$X.XX` prefix + `(memory/duration)` suffix
   that no constant can express. Defensible.

4. **Guard test completeness** — INCOMPLETE.
   `strategies/unit-label-convention.test.ts:38-43` imports only
   dynamodb / sns / apigatewayv2 / lambda. `snsPricingStrategy` and
   `apiGatewayV2PricingStrategy` are covered with multiple desiredState
   shapes, and Lambda's `estimateLocal` label is asserted for `/M
requests` (line 123-127). However:
   - **SQS is NOT in `TARGET_STRATEGIES`** — the guard cannot detect
     finding #1. If SQS had been included with `desiredState={}` the
     test would fail today (the strategy emits `/million requests`
     which matches `isPerMillionUnit` but does NOT match
     `/^\/M [a-z ]+$/`).
   - The `isPerMillionUnit` helper also accepts `~` — but Lambda's
     `estimateLocal` label is `~$0.41/M requests (...)` and the
     `mcpConfig` branch returns undefined for Lambda, so the unit
     check in the loop is never reached for Lambda's tilde'd label.
     The dedicated spot-check at line 123 covers it, so this is fine.

5. **Test-fixture updates honest** — OK.
   - `registry.test.ts:28,36` — was asserting `^~\$X\.XX\/million req`
     against Lambda's `estimateLocal.label`, now `^~\$X\.XX\/M
requests`. Legit — the label genuinely changed.
   - `preflight-guard.test.ts:1149,1165` — same pattern, legit.
   - `graph-integration.test.ts:452` — `expect(...).toMatch(/million
req/)` → `toMatch(/\/M requests/)`. Legit.
   - None of these were masking bugs; they're tracking the
     user-visible string change.

6. **CHANGELOG entry accurate** — MOSTLY OK, but misleading.
   The entry says "Four sites ... were emitting hand-rolled strings ...
   All four now route through the same `PriceUnit` constants and
   `formatUnitSuffix` path." The brief counted 5 sites (including
   apigatewayv2:75 HTTP path that was already on the
   `PER_MILLION_REQUESTS_LONG` constant — the entry doesn't credit that
   site). More importantly, the entry **omits SQS entirely**, leaving
   a reader to assume the strategies layer is now fully centralised
   when it is not.

7. **No drift introduced elsewhere** — FAIL.
   - `strategies/sqs.ts:34` retains `/million requests` (finding #1).
   - `packages/core/src/constants/pricing-api.ts:62` has a separate
     `MILLION_REQUESTS: "/million requests"` constant outside the
     `PriceUnit` map. Out of scope for this commit but worth flagging
     as a parallel-source-of-truth risk.
   - `packages/core/src/test-fixtures/checkpoints/single-lambda-scheduled.json:34`
     has `"estimatedMonthlyCost": "~$1.03/million req (100ms avg,
512MB)"`. This is a historical "pre-Epic-92 shape" fixture used
     only for a round-trip test in `checkpoint/store.test.ts:234` that
     does NOT assert on the cost label — so it does not break tests
     today, but it is now visibly stale relative to the canonical
     output and will mislead anyone copying the fixture as a template.

8. **Lambda template literal preserved** — OK.
   `strategies/lambda.ts:27`:
   `` `~$${total.toFixed(2)}${formatUnitSuffix("request")} (${ASSUMED_AVG_DURATION_SEC * 1000}ms avg, ${memoryMb}MB)` ``
   Still includes total cost, duration in ms, and memory annotation.
   Guard test spot-check at line 123 confirms the new output contains
   `/M requests` and does NOT contain `million req`. OK.

## Findings

- **HIGH**: `packages/core/src/pricing/strategies/sqs.ts:34` —
  Strategy still emits `PriceUnit.PER_MILLION_REQUESTS_LONG`
  (`/million requests`), the exact drift this follow-on commit claims
  to close at the strategies layer. The new guard test does not
  import SQS so this is invisible to CI. **Proposed fix**: change
  `unit: PriceUnit.PER_MILLION_REQUESTS_LONG` to
  `unit: PriceUnit.PER_MILLION_REQUESTS`, add `sqsPricingStrategy` to
  `TARGET_STRATEGIES` in `strategies/unit-label-convention.test.ts`,
  and (in a follow-on or this commit) remove the now-unused
  `PER_MILLION_REQUESTS_LONG` from `price-units.ts:38`.

- **MED**: `strategies/unit-label-convention.test.ts:38-43` —
  `TARGET_STRATEGIES` is hand-maintained and does not enumerate all
  strategies in the directory. A new strategy emitting drift would
  not be caught. **Proposed fix**: import all `*PricingStrategy`
  exports from `strategies/index.ts` (or glob the directory) so the
  guard auto-covers any future strategy.

- **LOW**: CHANGELOG entry under-counts and omits SQS — currently
  says "Four sites ... All four now route through..." Should say
  "Five sites" (or fix SQS and say "all per-million strategies").

- **LOW**: `test-fixtures/checkpoints/single-lambda-scheduled.json:34`
  retains the legacy `~$1.03/million req (...)` value. Not blocking
  (no equality assertion against this field in the only test that
  loads the fixture) but a stale canonical example. **Proposed fix**:
  update the fixture string to `~$1.03/M requests (100ms avg, 512MB)`.

- **LOW (out of scope)**: `constants/pricing-api.ts:62` has a parallel
  `MILLION_REQUESTS: "/million requests"` constant. If still used,
  it's a drift source outside the `PriceUnit` registry. Worth
  inspecting in a follow-on commit but not blocking for this review.

## Notes

The work delivered IS high-quality on the sites it touched: the
constants are clean, the `formatUnitSuffix` derivation in
`price-units.ts:21-28` is exactly the right pattern, the spot-check
test asserts canonical values (not regex) which catches pluralisation
drift, and the test-fixture updates are honest tracking of a real
display-string change.

The reject is solely because the **scope of the fix was defined too
narrowly**. The reviewer (me, in the EPIC-106-9 review) named 4
sites; the dev fixed those 4 + the already-constant'd apigatewayv2
HTTP path. A 5th strategy (SQS) was using the same now-deprecated
long-form constant and was overlooked. Per project rule
`feedback_fix_all_issues`, if you grep for the symptom (`/million`)
during a centralisation commit, you fix every site you find — you
don't ship "centralisation" with one outlier still emitting the old
shape.

Resolution path: a one-line edit to `strategies/sqs.ts` (swap
constant), a one-line edit to `strategies/unit-label-convention.test.ts`
(add sqs to `TARGET_STRATEGIES`), a CHANGELOG tweak, and ideally
remove `PER_MILLION_REQUESTS_LONG` from `price-units.ts`. ~10 LOC
total and the guard then mechanically forbids the drift returning.
