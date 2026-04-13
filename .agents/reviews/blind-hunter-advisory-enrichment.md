# Blind Hunter — Story 46.3 Advisory Price Enrichment

Reviewer: Blind Hunter (shallow-spec bugs — assertions that pass but do not verify what the test name claims)
Scope: enricher service + enricher tests + cost-advisor tests + advice-generator wiring

## Summary

7 real findings. Tests pass but several would let material regressions ship silently — most notably no test asserts on serviceCode/filter payloads, no test exercises the timeout path, and the failure-isolation test has a pin-down gap.

---

## HIGH

### H1. Live MCP test never verifies serviceCode or filter payload

File: `apps/cli/src/services/__tests__/advisory-price-enricher.test.ts:79-97, 181-205`

The dispatch mock only inspects `args.filters[field=productFamily].Value`. serviceCode, region, and every non-productFamily filter (usagetype, scale, output_options) are thrown away.

Bug let through: If a future refactor sends NAT Gateway to `SC.CLOUDWATCH` by mistake (wrong service code), or drops `FV.NAT_GATEWAY_HOURS` so the filter matches a NatGateway-Bytes row, the test still passes because the mock matches purely on productFamily="NAT Gateway" and returns $0.045. The `(live)` label with 32.85 would still appear. Same concern for EventBridge `scale=1_000_000`: if a refactor drops `scale`, no test catches it because the live path has no assertion for the EventBridge ID at all (see H2).

Fix: In `makeFilterDispatchedPricingTool`, assert on `args.service_code` matches the expected SC per productFamily and assert all expected filter fields are present. Add at least one assertion that inspects the full invoke call args (`expect(tool.invoke).toHaveBeenCalledWith(expect.objectContaining({ service_code: SC.EC2, filters: expect.arrayContaining([...]) }))`).

### H2. Four of seven enrichable IDs have zero live-path coverage

File: `apps/cli/src/services/__tests__/advisory-price-enricher.test.ts:181-224`

Only NAT_GATEWAY_MONTHLY, ALB_MONTHLY, CW_ALARM_PER_MONTH are exercised on the live path. EFS_PROVISIONED_PER_MIBS_MONTH, CW_LOGS_INGESTION_PER_GB, CF_INVALIDATION_EACH, EVENTBRIDGE_CUSTOM_PER_MILLION are only asserted as falling back when their response is missing.

Bug let through: The EventBridge `scale: 1_000_000` multiplier, the CF `$X.XXX` 3-decimal format, and the CW Logs "DataProcessing-Bytes" usagetype filter could each silently break (wrong number, wrong format, wrong filter) and no test would notice. The story explicitly calls out that 7 prices are enriched — the registry says so — but the live-path assertions only cover 3/7.

Fix: Parametrize the live path over `ENRICHABLE_PRICE_IDS`, each with an expected dollar amount given a fixed mock input. Explicitly assert EventBridge scale: input `$1/million events` should produce a monthly label embedding "$1.00" after the scale multiplier.

### H3. Timeout path never tested — `withTimeout` null branch is dead to coverage

File: `apps/cli/src/services/advisory-price-enricher.ts:221-239`; test file has no timeout case.

`withTimeout` returns `null` (not a thrown error) on the 3000ms budget. The enricher checks `if (raw === null)` and logs `PRICING_TIMEOUT`. No test drives this path.

Bug let through: A refactor that removes the `=== null` check, or replaces `withTimeout` with one that throws instead of resolves-null, or drops the timeout wrapper entirely — all pass. Even worse: if a refactor decided "timeout is a rejection," failure isolation still covers the rejection path, so the timeout-specific log (`LOG_ACTIONS.PRICING_TIMEOUT` vs `PRICING_UNAVAILABLE`) silently stops firing, breaking observability.

Fix: Use `vi.useFakeTimers()`, mock `pricingTool.invoke` to return a Promise that never resolves, `vi.advanceTimersByTime(3001)`, then assert the resulting map has a fallback entry AND that the log was called with `LOG_ACTIONS.PRICING_TIMEOUT`.

---

## MEDIUM

### M1. Failure-isolation test does not pin down WHICH id fails

File: `apps/cli/src/services/__tests__/advisory-price-enricher.test.ts:227-252`

The mock throws on the first call then returns the NAT Gateway response for all subsequent calls. The assertion is `failedCount > 0`. A regression that causes ALL seven queries to fail still satisfies `failedCount > 0` and passes the test.

Bug let through: If `Promise.allSettled` is accidentally replaced with `Promise.all` plus a wrapper that fallbacks on first rejection for ALL entries, the test still passes. Also: ordering-dependent — `Promise.allSettled` does not guarantee the "first" invoke is for the first id in the registry, so even the name "one throwing fetch" is not actually what the test measures.

Fix: Pin down behavior — assert `failedCount` equals exactly the expected count for this mock (1 thrown + N without matching filter = specific number), AND assert the remaining IDs that DO match the NAT response are tagged "mcp". Use a filter-dispatched mock that throws only for a specific productFamily.

### M2. Cost-advisor "(live)" test would pass if the token appeared anywhere in the hint

File: `apps/cli/src/nodes/advice/cost-advisor.test.ts:377-406`

Test asserts `h.includes("~$32.85/mo (live)") && h.includes("NAT Gateway")`. That is OK for the exact substring — but the "(estimated)" empty-map test at line 408-423 only asserts `h.includes("(estimated)")`. If a regression leaves the old hardcoded "$32" hint in place AND also appends "(estimated)" elsewhere via a bug (e.g. both `enrichedLabel` and a stray template), it still passes.

Bug let through: The empty-map test does not verify the dollar amount came from the formatter — any hint string containing "(estimated)" and the word "NAT Gateway" passes, including stale text.

Fix: Assert the empty-map test produces the specific string `~$32.00/mo (estimated)` (the fallback value is `NAT_GATEWAY_MONTHLY_APPROX = 32`, formatter `.toFixed(2)` → "32.00").

### M3. Advice-generator has no overall timeout on the parallel block

File: `apps/cli/src/nodes/advice-generator.ts:84-89`

The enricher has a per-query 3s budget, but `Promise.allSettled([enrichAdvisoryPrices, gatherMcpAdviceContext])` has no outer bound. `gatherMcpAdviceContext` is an entirely separate code path — if IT hangs, the entire advice-generator hangs indefinitely, blocking plan generation. This is not covered by any test here.

Bug let through: A misbehaving MCP tool in `gatherMcpAdviceContext` freezes the whole CLI plan flow. No regression test for this.

Fix: Either wrap `gatherMcpAdviceContext` in its own `withTimeout`, or wrap the outer `Promise.allSettled` in `Promise.race` with a bounded deadline (e.g. 5s). Add a test that stubs a never-resolving mcp-context and asserts the node still returns.

---

## LOW

### L1. `buildFallbackEnriched` exported but unused — dead code

File: `apps/cli/src/constants/advisory-prices.ts:140-149`

Grep confirms: the only file that references `buildFallbackEnriched` is the file that exports it. The story description says cost-advisor uses it as a defensive default, but `cost-advisor.ts:54-63` uses a local inline `enrichedLabel` function that calls `formatLabelWithSource` directly — it does NOT call `buildFallbackEnriched`. The enricher service has its own private `buildFallback`.

Bug let through: None directly, but the exported API surface lies about its purpose. A future dev could wire it in and get a subtly different result (EnrichedPrice object vs bare label string). Either inline-use it from `cost-advisor.ts` so the advisor and enricher share one path, or delete it.

Fix: Have cost-advisor's `enrichedLabel` call `buildFallbackEnriched(...).label` so there is one formatter in the project. Or delete the export.

---

## Non-findings (verified clean)

- ALB `16.43` rounding: verified via `node -e "(0.0225*730).toFixed(2)"` → "16.43". JS IEEE-754 representation of 16.425 is 16.42500000000000071...; `.toFixed(2)` rounds up. Test comment calls this "banker's rounding" — the comment is wrong (bankers' rounding would give 16.42) but the expected value "16.43" is correct for `.toFixed`. Cosmetic comment bug only.
- ELBv2 `PF.LOAD_BALANCER = "Load Balancer"` (not "Load Balancer-Application") — the enricher mirrors the existing elbv2 strategy, so this is not a 46.3 regression. Flag for a separate epic if ALB vs NLB pricing must diverge.
- CW Alarm filter has no ALARM_TYPE filter → could match high-res pricing. The advisor's hint says "Standard alarms cost X — high-resolution cost 3x more", so if the API returns the high-res rate first, the hint would lie. But this matches existing strategy behavior; not a 46.3-specific regression. Flag for follow-up.
- Regex `/\$([\d.]+)/` won't match comma-formatted prices, but AWS Pricing API responses use plain decimal strings; safe.
- `ENRICHABLE_PRICE_IDS` is `Object.freeze`d — mutation attempts throw in strict mode. Safe.
- Synchronous-throw test at `.test.ts:272-286` — the `invoke` arrow uses `vi.fn(() => { throw })`. `enrichOne` calls `pricingTool.invoke(...)` synchronously inside a `try` inside an `async` function, so the synchronous throw IS caught. Verified by reading the control flow.

---

Word count: ~690
