# Blind Hunter — Story 46.2 DataSource attribution

Shallow-specification bugs: tests that pass but do not verify what the name claims, so a real regression would ship silently.

## 1. REGISTERED_TYPES has no drift guard against `pricing/index.ts`

- File: `packages/core/src/pricing/pricing-source.test.ts:42-90`
- Severity: HIGH
- Bug it lets through: The test iterates `REGISTERED_TYPES` (hand-maintained) and asserts each type exists in `defaultPricingRegistry`. It never asserts the reverse — that every registered strategy is in `REGISTERED_TYPES`. A new strategy added to `pricing/index.ts` (e.g. a future `AWS::Route53::HostedZone`) will silently skip the `estimateLocal()` / `isFree↔source` matrix. The header comment even admits it: "Adding a new pricing strategy … won't enroll automatically". The file header claims a "registry coverage" test catches drift, but it only catches drift in the deletion direction.
- Fix: Expose `PricingStrategyRegistry.keys()` / `size` and add `expect(new Set(REGISTERED_TYPES)).toEqual(new Set(defaultPricingRegistry.keys()))`. Or assert `defaultPricingRegistry.size === REGISTERED_TYPES.length` as a cheap smoke.

## 2. `REGISTERED_TYPES.length >= 30` is a rubber stamp

- File: `packages/core/src/pricing/pricing-source.test.ts:83`
- Severity: MEDIUM
- Bug it lets through: Registry currently holds 36 strategies. Weakening the list by removing 5 types (e.g. deleting half the Events::\* family) still passes `>= 30`. The whole point is to detect accidental removals.
- Fix: `expect(REGISTERED_TYPES.length).toBe(36)` or assert exact equality with `defaultPricingRegistry.size`.

## 3. `preflight-guard-pricing.test.ts` "tool missing" and "tool throws" tests are indistinguishable by assertion

- File: `apps/cli/src/nodes/preflight-guard-pricing.test.ts:771-797`
- Severity: HIGH
- Bug it lets through: Both tests assert `result.estimatedMonthlyCostSource === "fallback"`. The "throws" test wires a `failingTool` whose `invoke` rejects — but the same outcome is produced by the `if (!pricingTool)` early return at `preflight-guard.ts:377` if `tools.find(t => t.name === ToolName.GET_PRICING)` fails to match. If someone renames `ToolName.GET_PRICING`, a type-mismatched tool array, or the filter condition changes, the catch block at 413-422 will never run, yet the test will still report green. A regression where the catch branch silently swallows the wrong exception, or where PRICING_UNAVAILABLE is no longer logged, would not fail.
- Fix: Spy on `failingTool.invoke` and assert it was called (`expect(invokeSpy).toHaveBeenCalledTimes(1)`). Additionally assert the `PRICING_UNAVAILABLE` log line was emitted. That pins the assertion to the catch-block path specifically.

## 4. `headlineCost` usage-based branch hard-codes `costEstimateSource = "mcp"` — ignores cache

- File: `apps/cli/src/nodes/preflight-guard.ts:597-610` (also 583-589 for fixedSubtotal)
- Severity: HIGH
- Bug it lets through: `queryLineItemPrices` feeds line items through `getCachedPrice()`. A cache hit still ends up in `firstPriced.displayPrice`, and the headline is then tagged `"mcp"` — labelling replayed cache data as "(live)". The whole point of the `cached` DataSource variant is to prevent exactly this. There is no test for "preflight headline reused from cache ⇒ source is cached", so nothing fails. Per Story 46.2's DataSource doc (`"cached … Recent but not 'right now'"`), this flow should tag `cached`.
- Fix: Enrich `PricingLineItemResult` with a `source: DataSource` field derived from the cache-hit branch (`cached` vs `mcp`), then take the max-freshness of contributing line items for the headline. Add a test: run `queryLineItemPrices` once to populate the cache, re-run, and assert `estimatedMonthlyCostSource === "cached"`.

## 5. `security-posture.ts` source override silently clobbers future MCP source field

- File: `apps/cli/src/utils/security-posture.ts:50-55`
- Severity: MEDIUM
- Bug it lets through: `(rawFindings as SecurityFinding[]).filter(...).map((f) => ({ ...f, source: "mcp" as const }))` places `source` AFTER the spread. If the WA-Security MCP server (v0.1.8+) starts returning its own `source` field — for example to mark a historical Security Hub finding as `"cached"` — our override silently clobbers it. The code comment acknowledges the MCP "doesn't carry a source field of its own" but there is no defence / test asserting behavior when it does.
- Fix: Either (a) preserve existing: `({ source: "mcp", ...f })` with explicit fallback, or (b) add a runtime guard + log when `f.source` is already present. Add a test that passes a rawFinding with `source: "cached"` and asserts preservation or explicit collision detection.

## 6. `billing.test.ts` queryCostAnomalies "empty" branches do not assert source

- File: `apps/cli/src/services/billing.test.ts:582-605, 638-651, 685-`...
- Severity: LOW
- Bug it lets through: The no-tool / no-key / throw tests assert `toEqual([])` — the empty array cannot carry a source, fine. But there is no test for the case "MCP returns one anomaly AND the `source` field is set to 'mcp' AND every other anomaly field is populated with real data" for the `severity`/`impact` string-coerce branches. The one anomaly test uses a single object with all fields set; if parsing changes so `Severity` coerces to `undefined` → `"undefined"`, nothing fails. Not a 46.2 bug per se, but the new `source` assertion (line 579) is the only thing watching that block.
- Fix: Add a parametrized test for the `?? "MEDIUM"` default fallback and assert source is still `"mcp"` in that case.

## 7. `formatCostLine(undefined, "mcp")` → `"N/A (live)"` is actively misleading and the test enshrines it

- File: `apps/cli/src/utils/display-plan.test.ts:31-36` / `apps/cli/src/utils/display-plan.ts:63-70`
- Severity: MEDIUM
- Bug it lets through: The test's own comment tries to justify rendering "(live)" after "N/A" ("a missing value when MCP succeeded is genuinely '(live)'-tagged N/A"). But `undefined` reaches `formatCostLine` in the exact opposite scenario: `state.estimatedMonthlyCost` is `undefined` precisely when the MCP path produced no label. Claiming the absence is "live" is a UX lie — users will read "N/A (live)" as "AWS just confirmed this is unpriceable". The test locks in the bug by asserting it.
- Fix: Special-case `label === "N/A"` / undefined in `formatCostLine` to suppress the suffix (or return `"N/A (estimated)"` for fallback only). Rewrite the test to assert the suppressed behaviour.

## 8. Apply-now prompt double-appends `/mo`

- File: `apps/cli/src/utils/display-prompts.ts:108-115`
- Severity: MEDIUM
- Bug it lets through: `costLabel` is built via `formatLabelWithSource(state.estimatedMonthlyCost ?? "N/A", source)`. Because pricing strategies return labels that already include `/mo` (e.g. `"$32.85/mo"`), the template string `est. ${costLabel}/mo` now renders `est. $32.85/mo (live)/mo`. With 46.2 this reads: `"$32.85/mo (live)/mo"` — the `/mo` sits after the suffix, making it look like the suffix modifier has its own unit. Free-tier path renders `est. Free/mo`. No display-prompts test exists for 46.2, so this regression landed unobserved.
- Fix: Strip the trailing `/mo` from `costLabel` before rendering, or drop the literal `/mo` from the template. Add a snapshot test in `display-prompts.test.ts`.

## 9. `isFree ↔ source:"free"` invariant test only hits the empty-desiredState code path

- File: `packages/core/src/pricing/pricing-source.test.ts:101-115`
- Severity: MEDIUM
- Bug it lets through: Test calls `estimate(resourceType, {})` — empty desired state. Many strategies branch on properties (ssm Advanced tier, eventsRule custom bus, kms customer-managed) that only diverge when desiredState is populated. A strategy that returns `isFree:true, source:"fallback"` only when `{ Tier: "Advanced" }` is passed will never be tested. Specifically:
  - `ssm.ts` Advanced tier returns `{ perMonth: null, label: "N/A", source: "fallback" }` with `isFree` unset — passes, but I could flip `source` to `"free"` on the Advanced branch and the test wouldn't catch it.
  - `events-rule.ts` custom-bus branch returns `source: "fallback"` — same story.
- Fix: Either (a) parametrize over multiple `desiredState` shapes per strategy (at minimum the branches declared in each strategy), or (b) add a second matrix that drives every `if` branch explicitly per type.

## 10. `source="free"` smoke test relies on label-substring only

- File: `packages/core/src/pricing/pricing-source.test.ts:132-138`
- Severity: LOW
- Bug it lets through: Asserts `formatLabelWithSource("anything-here", "free") === "anything-here"`. Does not verify NO suffix was appended — a regression that adds a zero-width space or a trailing whitespace would pass `.toBe("anything-here")` only if length matches exactly, but e.g. `" (free)"` turning into `""` (bug) vs `" "` (worse bug) — the latter fails, the former passes. Fine. Stronger assertion: verify `SOURCE_SUFFIX.free === ""` directly.
- Fix: Add `expect(formatLabelWithSource("X", "free").length).toBe(1)` and assert the record entry `SOURCE_SUFFIX.free === ""` via an exported helper, or re-export the record read-only.

## 11. Preflight "mcp" test does not verify extractFirstTierPrice returned non-null

- File: `apps/cli/src/nodes/preflight-guard-pricing.test.ts:754-769`
- Severity: MEDIUM
- Bug it lets through: Test asserts `estimatedMonthlyCostSource === "mcp"` and `estimatedMonthlyCost` is defined. But if the filter-dispatched tool drifts so `extractFirstTierPrice` returns `null`, the code path at `preflight-guard.ts:412` returns `{ label: "N/A", source: "fallback" }`. The test would start failing on the `"mcp"` assertion — good — EXCEPT if someone simultaneously changes the `null`-extracted branch to return `source: "mcp"` (reasoning "the MCP did respond"), the test keeps passing while mislabeling. The tighter contract is: "source is mcp AND label is a real dollar amount (not N/A)".
- Fix: Add `expect(result.estimatedMonthlyCost).toMatch(/^\$[\d.]+/)` alongside the `"mcp"` assertion. Also assert the local estimate was NOT returned by checking the numeric content differs from `defaultPricingRegistry.estimate("AWS::S3::Bucket", {}).label`.
