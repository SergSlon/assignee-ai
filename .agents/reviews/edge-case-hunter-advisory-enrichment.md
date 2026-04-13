# Edge Case Hunter — Story 46.3 Advisory Price Enrichment

Method-driven boundary walk. 10 findings.

---

## 1. EVENTBRIDGE_CUSTOM `scale: 1_000_000` double-multiplies the rate

**File:** `apps/cli/src/services/advisory-price-enricher.ts:169-182`

`extractFirstTierPrice` already multiplies the raw USD by `scale` before returning (`mcp-parser.ts:98` → `usd * scale`). So `"$1000000.0000/million events"` comes back, `extracted.match(/\$([\d.]+)/)` captures `"1000000.0000"`, no `convert` callback → `format($1000000.00)`. The EventBridge hint will read `$1000000.00 per million events (live)` instead of `$1.00`.

**Fix:** Drop `scale: 1_000_000` OR add `convert: (v) => v / 1_000_000`. Tests don't cover this code path — the test suite only exercises NAT/ALB/CWAlarm responses, so this regression ships untested.

---

## 2. Regex `/\$([\d.]+)/` accepts strings with multiple dots

**File:** `advisory-price-enricher.ts:253`

`[\d.]+` is greedy and unanchored — a label like `"$0.04.50/hour"` (hypothetical future upstream bug) captures `"0.04.50"`, `parseFloat("0.04.50") = 0.04`, passes `>0` check, silently ships a 10x-wrong value as "live". The comment on line 250 claims the format is stable, but the code's defensive posture elsewhere (try/catch, null guards) suggests we don't trust it.

**Fix:** Use `/\$(\d+(?:\.\d+)?)/` to require at most one decimal.

---

## 3. ALB filter matches any Load Balancer — NLB/GLB/CLB rate contamination

**File:** `advisory-price-enricher.ts:114-123`

The filter is `productFamily="Load Balancer"` only. AWS Pricing API returns NLB, ALB, GWLB, and CLB rows under the same productFamily. `extractFirstTierPrice` picks the first matching item; ordering is server-defined. For `us-east-1`, NLB and ALB are coincidentally close (~$0.0225/hr each), but in partitions with different per-LB rates this ships the wrong number as "live" with high confidence.

**Fix:** Add a `usagetype` filter (e.g. `LoadBalancerUsage` for classic, `LBCapacityUnits` region-prefixed for ALB), or filter on `group`/`operation` = `"ELB:LoadBalancing"` + explicit LB type attribute.

---

## 4. EFS Storage filter matches wrong storage class

**File:** `advisory-price-enricher.ts:124-132`

`productFamily="Storage"` with no additional filter. EFS has Standard, IA, One Zone Standard, One Zone IA, Archive — all under `productFamily=Storage`. But the hint is about **Provisioned Throughput**, which is a completely different productFamily in the pricing API (`"Provisioned Throughput"`). This query retrieves a per-GB storage rate ($0.30/GB-mo) and labels it as `~$0.30/MiB-s-month`, off by ~20x.

**Fix:** Change filter to `productFamily="Provisioned Throughput"`. Current test (`buildPricingResponse("Storage"...)`) would pass with the wrong query.

---

## 5. CW Alarm filter returns high-res or composite rate instead of standard

**File:** `advisory-price-enricher.ts:133-141`

`productFamily="Alarm"` alone. The Pricing API returns Standard ($0.10), High-resolution ($0.30), and Composite ($0.50) alarm rows. The hint explicitly says `"Standard alarms cost ..."` but the query may surface the first row, which is unspecified. On a partition change, the label becomes contradictory: `"Standard alarms cost $0.50/alarm/month (live)"`.

**Fix:** Add filter on `usagetype` containing `"CW:AlarmMonitorUsage"` (standard) OR attribute `alarmType="Standard"`.

---

## 6. CW Logs Ingestion `usage_type` filter assumes us-east-1 prefix-less name

**File:** `advisory-price-enricher.ts:142-155`

Filter uses `"DataProcessing-Bytes"` verbatim. Real CloudWatch Logs usage types are region-prefixed (`USE1-DataProcessing-Bytes`, `EUW1-DataProcessing-Bytes`, etc.) — plain `"DataProcessing-Bytes"` won't match in any region except potentially us-east-1 unprefixed rows that may not exist. Result: silent fallback in every non-USE1 region, "(live)" never appears for the CloudWatch Logs hint in EU/APAC tenants.

**Fix:** Either use `Type: "CONTAINS"` (if supported) or prefix-aware filter composition, or use a different unique field (`operation="PutLogEvents"`).

---

## 7. `rawRate <= 0` rejection silently discards free-tier valid prices

**File:** `advisory-price-enricher.ts:258`

`extractFirstTierPrice` already filters `usd > 0`, so a genuine `$0` base rate never reaches here. But the `<=0` check plus the regex design rejects `"$0.00"` rounding artifacts. More importantly, the rejection silently drops to fallback with no log breadcrumb — making "why is this showing estimated when MCP returned a response?" undebuggable. Only timeouts (`raw === null`) and outer catch get logged.

**Fix:** Add a `PRICING_PARSE_FAILED` log action on null regex / rate ≤ 0 / non-finite to distinguish parse failure from timeout/unavailable.

---

## 8. `enrichedSettled` fallback re-invokes the enricher synchronously, doubling wall-clock

**File:** `apps/cli/src/nodes/advice-generator.ts:90-93`

```
const enrichedPrices =
  enrichedSettled.status === "fulfilled"
    ? enrichedSettled.value
    : await enrichAdvisoryPrices(undefined, state.runId);
```

`enrichAdvisoryPrices` is designed to NEVER reject (every failure path resolves to fallback inside `enrichOne`). The `status !== "fulfilled"` branch is therefore dead code — but if it ever fires (defensive future change), calling `enrichAdvisoryPrices(undefined)` does synchronous fallback construction, which is fine. However the comment/intent reads as "retry" — that's misleading. The real bug: if `enrichAdvisoryPrices` ever throws at the top level (e.g. a synchronous error in `tools?.find`), the caller now runs the enricher a SECOND time in series, blocking the advice node for an additional timeout window.

**Fix:** Replace fallback branch with a direct synchronous all-fallback map builder (no `await`), or add a comment asserting the dead-code nature.

---

## 9. Concurrent 7-query fan-out ignores the shared `price-cache.ts`

**File:** `advisory-price-enricher.ts:214-277`

Each `enrichOne` call invokes `pricingTool.invoke` directly. The Pricing MCP server caches internally, but the CLI-side `price-cache.ts` (used by cost decomposers) is bypassed. On every `assignee plan` invocation, 7 fresh MCP round-trips fire — compounding with the decomposers' own pricing calls on the same resources. For a VPC plan with NAT + ALB + CW alarms, the same NAT Gateway rate gets fetched by both the decomposer (cached) AND the enricher (uncached) in the same run.

**Fix:** Route `enrichOne` through `price-cache.ts` with a key like `advisory:${id}:${AWS_REGION}` so plan-to-plan cache hits materialize and the two code paths share memory.

---

## 10. `enrichedLabel` helper synthesizes fallback with a DIFFERENT formatter than the enricher

**File:** `apps/cli/src/nodes/advice/cost-advisor.ts:54-63` vs `advisory-price-enricher.ts:98-183`

Two independent formatter definitions for the same price. EFS provisioned: enricher uses `(v) => `$${v.toFixed(0)}/MiB-s-month`` (line 278), advisor fallback uses `(v) => `$${v.toFixed(0)}/MiB-s-month``— **match**. But CF invalidation: enricher uses`toFixed(3)` (`$0.005`), advisor fallback uses `toFixed(3)` (`$0.005`) — match. NAT: both `toFixed(2)`— match. **Today they all line up**, but there is ZERO lock preventing drift: if someone updates one formatter and forgets the other, the`(live)`and`(estimated)` labels diverge visually for the same underlying value, making provenance debugging confusing.

**Fix:** Export the format-callback registry from `advisory-prices.ts` (or from the enricher) as a single `ADVISORY_PRICE_FORMATTERS` record keyed by `AdvisoryPriceId`. Both the enricher and `enrichedLabel` read from it. TypeScript enforces parity.

---

## Bonus: runId default `"advisory-enricher"` obscures correlation

**File:** `advisory-price-enricher.ts:287`

Default `runId = "advisory-enricher"` — a static string. If `advice-generator.ts` passes `state.runId` (it does), fine. But unit tests and any direct caller get the static default, which means log correlation across a multi-run debug session shows every orphan timeout under the same fake runId. Minor, but the default should be `""` or a UUID, not a semantic impostor.
