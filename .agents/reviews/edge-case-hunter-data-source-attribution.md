# Edge Case Hunter — Story 46.2 DataSource Attribution

Scope: walked every branch in types.ts, preflight-guard.ts (pricing + rewrite),
display-plan.ts, display-prompts.ts, billing.ts, security-posture.ts, and the
new pricing-source.test.ts. Orthogonal to adversarial review — only
unhandled-branch findings below.

---

## F1. `renderApplyNowConfirm` double-appends "/mo" after the source suffix

**File:** `apps/cli/src/utils/display-prompts.ts:108-115`

```ts
const costLabel = state.estimatedMonthlyCostSource
  ? formatLabelWithSource(state.estimatedMonthlyCost ?? CostEstimateLabel.NA,
                          state.estimatedMonthlyCostSource)
  : (state.estimatedMonthlyCost ?? CostEstimateLabel.NA);
const result = await clack.confirm({
  message: `Apply now? (${state.resourceType}, est. ${costLabel}/mo)`,
```

When `estimatedMonthlyCost = "~$32.85/mo"` and source is `"mcp"`, `costLabel`
becomes `"~$32.85/mo (live)"`, and the template appends a second `/mo`, giving
`"est. ~$32.85/mo (live)/mo"`. The old code expected a bare number; the new
code passes a fully-formatted label through the same template. Every non-free
source hits this — nobody noticed because there's no renderApplyNowConfirm
test that asserts the rendered message.

**Fix:** drop the trailing `/mo` from the template string, or format the cost
without it. Also add a display-prompts.test.ts case that spies on
`clack.confirm` and asserts the message.

---

## F2. `preflight-guard` discards `localEstimate` when extractFirstTierPrice returns null

**File:** `apps/cli/src/nodes/preflight-guard.ts:409-412`

The inline comment says _"Fall back to the local estimate and keep its source"_
but the code returns `{ label: CostEstimateLabel.NA, source: "fallback" }` —
it throws away `localEstimate` entirely. For a resource whose local strategy
produced a real label (e.g. apigatewayv2 WebSocket → _"WebSocket — per-
connection-minute + per-message pricing (query Pricing MCP)"_), the user
suddenly sees `N/A (estimated)` instead of the explanatory local label, and
a free-tier resource that happens to have an `mcpConfig` would lose its
`source: "free"` tag.

**Fix:** `return { label: localEstimate, source: localSource };` to match
the comment and all the sibling branches at lines 375, 377, 397, 421.

---

## F3. Headline-rewrite paths flip `source` to "mcp" even when the original was "free"

**File:** `apps/cli/src/nodes/preflight-guard.ts:577-609`

Both rewrite blocks unconditionally set `costEstimateSource = "mcp"` when
`headlineCost === CostEstimateLabel.NA`. The check `headlineCost === NA` was
meant to gate "only rewrite when the single-line query failed" but it does
not inspect `costEstimateSource`. If `localPricing` returned
`{label: "N/A", source: "free"}` for a decomposer-backed free-tier resource
(e.g. ECS cluster with capacity providers producing zero fixedSubtotal but
non-empty usage-based items), the free tag is overwritten with "mcp" — which
then slaps "(live)" onto a resource the local strategy authoritatively
knows is free.

**Fix:** gate the rewrites on `costEstimateSource !== "free"`, OR keep
`"free"` when `pricingBreakdown.fixedSubtotal === 0`.

---

## F4. `queryCostAnomalies`/`queryCostOptimization`/`queryComputeOptimizer` swallow catch with `[]`

**File:** `apps/cli/src/services/billing.ts:418-420, 459-461, 508-510`

Each catch returns `[]` silently — no log line, no telemetry, no way to
distinguish "there really are zero anomalies" from "the MCP tool crashed
and we hid it." Story 46.2's whole point is provenance visibility; an empty
array with no source is an attribution hole. `checkSecurityPosture` at
least writes to stderr — billing should match.

**Fix:** log `level:"warn", action: BILLING_QUERY_FAILED` in each catch
so the user can see that the anomalies/recommendations list is empty
because of a failure, not because the data is clean.

---

## F5. "falls back to provision log when MCP returns empty" test doesn't assert `source:"offline"`

**File:** `apps/cli/src/services/billing.test.ts:153-175`

This test exercises the exact fall-through path (AC #7 requires it) but
unlike its siblings on lines 101-125 and 127-151, it asserts only
`actualMonthlyCost` — NOT `source: "offline"`. A regression that tagged
the fallback row `"mcp"` (e.g. forgot to reset the variable after the MCP
path hit zero rows) would pass this test.

**Fix:** add `expect(result.get(sampleResource.arn)!.source).toBe("offline")`.

---

## F6. ssm / events-rule / apigatewayv2 tier/bus/protocol branches are NEVER exercised by pricing-source.test.ts

**File:** `packages/core/src/pricing/pricing-source.test.ts:92-115`
(strategies: `ssm.ts:29/39`, `events-rule.ts:33/46`, `apigatewayv2.ts:29/37`)

The parametrized test calls `estimate(resourceType, {})` with an **empty**
desiredState for every strategy. For strategies with conditional branches
driven by desiredState:

- `ssm.ts` — empty → `tier` defaults to Standard → `source:"free"`. The
  Advanced tier branch at line 39 (`source:"fallback"`) is never tested.
- `events-rule.ts` — empty → `bus === "default"` → `source:"free"`. The
  custom-bus branch at line 46 (`source:"fallback"`) is never tested.
- `apigatewayv2.ts` — empty → `protocol` defaults to HTTP → `source:"fallback"`.
  The WebSocket branch at line 30 is never tested.
- `ec2.ts`, `rds.ts`, `cloudfront-distribution.ts` likely have similar
  instance-class / engine-type branches that all resolve to the same
  default shape.

The story's stated purpose is "no unattributed values reach display" — but
the half of every conditional strategy that the default-state matrix
doesn't hit could silently omit `source` and the test wouldn't catch it.

**Fix:** extend `pricing-source.test.ts` with a second matrix that passes
realistic desiredState for each branching strategy (Standard vs Advanced
SSM, default vs custom event bus, HTTP vs WebSocket, at least one compound
size/instance case). Better yet, parametrize the existing matrix over
`[emptyState, ...branchStates]` per strategy.

---

## F7. `formatCostLine(undefined, "mcp")` produces `"N/A (live)"` — semantically wrong

**File:** `apps/cli/src/utils/display-plan.ts:63-70`

If the live MCP fetch "succeeded" with a null extracted price and the
rewrite path never kicked in, `state.estimatedMonthlyCost` can be
`CostEstimateLabel.NA` while `state.estimatedMonthlyCostSource === "mcp"`
(see F2 — this is the path that sets `source: "fallback"` now but will flip
to `"mcp"` if a future edit trusts the "we talked to the API" signal).
Rendering `N/A (live)` tells the user "we have live data that is N/A"
which is a contradiction — the user reads it as "AWS says N/A". Should
collapse to plain `N/A` when the label is the N/A sentinel.

**Fix:** `if (label === CostEstimateLabel.NA) return label;` before
applying the suffix.

---

## F8. `security-posture.ts` `.map(f => ({...f, source: "mcp"}))` blindly overrides any incoming `source`

**File:** `apps/cli/src/utils/security-posture.ts:55`

If a future WA Security MCP server version adds its own `source` field
(e.g. `"cached"` for results replayed from Security Hub findings that were
already stale), the spread `{...f, source: "mcp" as const}` silently
clobbers it. We commit to "always live" even though the real payload is
telling us otherwise.

**Fix:** `{...f, source: f.source ?? ("mcp" as DataSource)}`. Adds zero
cost today and lets upstream provenance flow through when/if the server
starts providing it.

---

## F9. `security-posture.ts` catch path writes stderr but emits no findings at all

**File:** `apps/cli/src/utils/security-posture.ts:60-71`

On MCP failure the function returns with no findings. From the display
layer's perspective the resource is indistinguishable from "MCP succeeded,
no HIGH/CRITICAL findings" — i.e. the user thinks security posture is
clean when actually we never checked. Story 46.2's provenance guarantee
is violated: the absence of findings has no attribution at all.

**Fix:** either surface a single synthetic finding
`{severity:"INFO", title:"Security posture check unavailable", source:"fallback"}`
or extend `RenderableState` with a `securityPostureStatus` enum the
display can surface as _"Security check: skipped (MCP unavailable)"_.

---

## F10. Type system won't catch a 6th `DataSource` variant in `formatCostLine`

**File:** `packages/core/src/pricing/types.ts:78-87`,
`apps/cli/src/utils/display-plan.ts:63-70`

`SOURCE_SUFFIX` is `Record<DataSource, string>` so adding a 6th value fails
at compile time _inside the record_ — good. But `formatCostLine` accepts
`source?: DataSource` and immediately delegates, so a future conditional
branch like `if (source === "mcp" || source === "cached") ...` hand-written
in display-plan would not be caught by an exhaustiveness check. No such
branch exists today, but the test at `pricing-source.test.ts:140-150`
claims it "catches a regression where a new DataSource variant is added
to the type union but the SOURCE_SUFFIX record forgets" — that claim is
false: the `Record<DataSource,string>` already forces compile-time coverage
of SOURCE_SUFFIX. The test is asserting a property TS guarantees and
provides no extra safety.

**Fix:** either delete the misleading comment, or replace the test with
one that exercises a display-layer switch over source (e.g. once
display-plan grows conditional formatting per variant).

---

## F11. `pricingBreakdown` line items carry no source — display prints them unattributed

**File:** `apps/cli/src/utils/display-plan.ts:176-225`
(`formatPricingBreakdown`)

`formatPricingBreakdown` renders `item.displayPrice` directly with no
suffix, but those prices come from `queryLineItemPrices` which mixes live
MCP results with cache hits and partial failures (`hasPartialFailure`).
The top-line cost gets `(live)` but the breakdown lines below it render
bare prices — a user looking at the plan box sees `$0.023/GB-month` and
`$0.005/GB-month` with zero indication that one was live and the other
was a cached stub. Story mentions this is "probably out of scope" but
the plan box inconsistency between "top line has suffix, breakdown
doesn't" actively _hides_ the provenance attribution the headline is
trying to provide.

**Fix:** flag as follow-up story (46.2.1), but at minimum render a single
`⚠ Some prices from cache` or `Prices: live` line above the breakdown
when `hasPartialFailure || anyCachedHits`.

---

Count: 11 findings. Highest-impact: **F1** (user-visible malformed prompt),
**F2** (broken fallback path contradicts its own comment), **F6** (huge
test coverage gap — half of every branching strategy is unexercised).
