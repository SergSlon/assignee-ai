/**
 * Advisory price enricher — fetches live AWS Pricing API rates for the
 * fixed-rate constants used by `cost-advisor.ts` so the inline hints
 * can render `$32.85/mo (live)` instead of the hand-coded `~$32 (estimated)`.
 *
 * Architecture:
 *   1. `cost-advisor.ts` enumerates which `AdvisoryPriceId`s its hints
 *      reference for the resource type being advised on.
 *   2. The advice-generator pipeline calls `enrichAdvisoryPrices(tools)`
 *      in its existing parallel block (alongside `gatherMcpAdviceContext`).
 *   3. The enricher fans every enrichable price out via Promise.allSettled
 *      with a per-fetch 3s timeout. Each result resolves to either:
 *        - `{value, label, source: "mcp"}` on a live extract success, OR
 *        - `{value: fallback, label, source: "fallback"}` on any failure
 *      so the call site never sees a missing entry.
 *   4. `cost-advisor.ts` reads `enriched.get(id).label` directly inside
 *      template literals — no per-hint fallback logic in the advisor.
 *
 * Scope discipline (Story 46.3 wave-2 review):
 *   The first wave shipped queries for 7 advisory price IDs, but 4 of
 *   them (EFS provisioned, CW Logs ingestion, CloudFront invalidation,
 *   EventBridge custom bus) had unverified filter sets / scale handling
 *   that the adversarial review flagged as silently incorrect. Until we
 *   have captured Pricing API responses for those product families, the
 *   enricher only ships verified queries (NAT Gateway, ALB, CW Alarm) —
 *   the same queries the existing pricing strategies use in production.
 *
 *   The other 4 IDs remain enum members so `cost-advisor.ts` can still
 *   reference them via `enrichedLabel(...)`. Their map entries are
 *   absent, which forces the helper's fallback path → the hint renders
 *   `~$X/mo (estimated)` instead of "(live)".
 *
 * @see Story 46.3 — Advisory price enrichment at runtime
 * @see .agents/reviews/blind-hunter-advisory-enrichment.md (wave-2 H2)
 * @see .agents/reviews/edge-case-hunter-advisory-enrichment.md (wave-2 #1-3)
 */

import {
  PricingField as F,
  PricingMatchType as M,
  PricingProductFamily as PF,
  PricingServiceCode as SC,
  PricingFilterValue as FV,
  formatLabelWithSource,
  extractFirstTierPrice,
  type AwsPricingResponse,
  type McpPricingFilter,
} from "@assignee/core";
import type { StructuredTool } from "@langchain/core/tools";
import { ToolName } from "../constants/tools.js";
import { AWS_REGION, HOURS_PER_MONTH } from "../config/constants.js";
import { PricingTerm } from "../constants/pricing.js";
import { withTimeout } from "../utils/timeout.js";
import { unwrapMcpText } from "../utils/mcp.js";
import { log, LOG_ACTIONS } from "../utils/logger.js";
import {
  AdvisoryPriceId,
  type EnrichedPrice,
  type EnrichedPriceMap,
  NAT_GATEWAY_MONTHLY_APPROX,
  ALB_MONTHLY_APPROX,
  CW_ALARM_PER_MONTH,
} from "../constants/advisory-prices.js";

/** Per-query budget — matches the existing advice-generator parallel block. */
const ENRICHMENT_TIMEOUT_MS = 3000;

/**
 * Internal spec for one enrichable advisory price. Adding a new ID
 * requires:
 *   1. Add an enum entry in `constants/advisory-prices.ts`
 *   2. Add a query spec here AND verify the filter set produces the
 *      right `extractFirstTierPrice` row against a captured response
 *   3. Reference `enriched.get(id).label` in the relevant hint
 */
interface AdvisoryPriceQuery {
  /** AWS Pricing API service code (e.g. AmazonEC2). */
  serviceCode: string;
  /** Filters that uniquely select the rate row in the response. */
  filters: McpPricingFilter[];
  /** Display unit string forwarded to extractFirstTierPrice. */
  unit: string;
  /** `extractFirstTierPrice` scale multiplier (default 1). */
  scale?: number;
  /** Hand-coded fallback used when the MCP path fails. */
  fallbackValue: number;
  /**
   * Convert the raw extracted hourly/per-unit rate into the value the
   * hint surfaces. Most queries return /hour and we want /month, so
   * `convert: (h) => h * HOURS_PER_MONTH` is common. The default is
   * identity (the raw rate IS the displayable value, e.g. $0.50/GB).
   */
  convert?: (raw: number) => number;
  /**
   * Format `value` into the bare label *without* the provenance suffix.
   * The enricher then runs the result through `formatLabelWithSource`
   * to append `(live)` / `(estimated)`.
   */
  format: (value: number) => string;
}

/**
 * Enrichable advisory price registry. Only verified queries — see the
 * "Scope discipline" comment at the top of this file. The IDs not
 * present here have intentionally absent map entries; the cost-advisor
 * helper falls back to the formatted constant tagged "(estimated)".
 *
 * Use `Partial<Record<...>>` so we can narrow the registry without
 * touching the enum, which `cost-advisor.ts` references for ALL 7 IDs.
 */
const ADVISORY_PRICE_QUERIES: Partial<
  Record<AdvisoryPriceId, AdvisoryPriceQuery>
> = {
  [AdvisoryPriceId.NAT_GATEWAY_MONTHLY]: {
    serviceCode: SC.EC2,
    filters: [
      { Field: F.PRODUCT_FAMILY, Value: PF.NAT_GATEWAY, Type: M.TERM_MATCH },
      {
        Field: F.USAGE_TYPE,
        Value: FV.NAT_GATEWAY_HOURS,
        Type: M.TERM_MATCH,
      },
    ],
    unit: "/hour",
    fallbackValue: NAT_GATEWAY_MONTHLY_APPROX,
    convert: (hourly) => hourly * HOURS_PER_MONTH,
    format: (monthly) => `~$${monthly.toFixed(2)}/mo`,
  },
  [AdvisoryPriceId.ALB_MONTHLY]: {
    serviceCode: SC.ELB,
    filters: [
      { Field: F.PRODUCT_FAMILY, Value: PF.LOAD_BALANCER, Type: M.TERM_MATCH },
    ],
    unit: "/hour",
    fallbackValue: ALB_MONTHLY_APPROX,
    convert: (hourly) => hourly * HOURS_PER_MONTH,
    format: (monthly) => `~$${monthly.toFixed(2)}/mo`,
  },
  [AdvisoryPriceId.CW_ALARM_PER_MONTH]: {
    serviceCode: SC.CLOUDWATCH,
    filters: [{ Field: F.PRODUCT_FAMILY, Value: PF.ALARM, Type: M.TERM_MATCH }],
    unit: "/alarm-month",
    fallbackValue: CW_ALARM_PER_MONTH,
    format: (rate) => `$${rate.toFixed(2)}/alarm/month`,
  },
};

/**
 * Snapshot of which AdvisoryPriceIds are currently enrichable. Derived
 * from the queries record so adding a new entry above automatically
 * extends iteration. Exposed read-only for the parametrized test suite.
 */
export const ENRICHABLE_PRICE_IDS: readonly AdvisoryPriceId[] = Object.freeze(
  Object.keys(ADVISORY_PRICE_QUERIES) as AdvisoryPriceId[],
);

/**
 * Build the fallback `EnrichedPrice` for a given query — used when the
 * MCP fetch fails (timeout, missing tool, malformed response). Tagged
 * `source: "fallback"` so the display layer renders `(estimated)`.
 */
function buildFallback(query: AdvisoryPriceQuery): EnrichedPrice {
  return {
    value: query.fallbackValue,
    label: formatLabelWithSource(query.format(query.fallbackValue), "fallback"),
    source: "fallback",
  };
}

/**
 * Try to fetch one advisory price from the live Pricing MCP server.
 * Returns the enriched value on success, or the fallback on any failure.
 * Never throws — every failure path resolves to a fulfilled fallback.
 */
async function enrichOne(
  id: AdvisoryPriceId,
  pricingTool: StructuredTool,
  runId: string,
): Promise<EnrichedPrice> {
  const query = ADVISORY_PRICE_QUERIES[id];
  if (!query) {
    // Defensive: enricher only iterates over ENRICHABLE_PRICE_IDS so this
    // can't happen via the public API. Fail loudly so a future regression
    // that calls enrichOne with an unenriched ID is obvious.
    throw new Error(`enrichOne called with id ${id} that has no query spec`);
  }
  try {
    const raw = await withTimeout(
      pricingTool.invoke({
        service_code: query.serviceCode,
        region: AWS_REGION,
        filters: query.filters,
        output_options: { pricing_terms: [PricingTerm.ON_DEMAND] },
      }),
      ENRICHMENT_TIMEOUT_MS,
    );
    if (raw === null) {
      // withTimeout returns null on timeout (does NOT throw).
      log({
        ts: new Date().toISOString(),
        runId,
        level: "warn",
        action: LOG_ACTIONS.PRICING_TIMEOUT,
        extras: { advisoryPriceId: id },
      });
      return buildFallback(query);
    }
    const data = JSON.parse(unwrapMcpText(raw)) as AwsPricingResponse;
    const extracted = extractFirstTierPrice(
      data,
      query.unit,
      query.scale,
      query.filters,
    );
    if (extracted === null) {
      // Filters matched but no valid price tier — log so silent
      // mismatches don't vanish.
      log({
        ts: new Date().toISOString(),
        runId,
        level: "warn",
        action: LOG_ACTIONS.PRICING_UNAVAILABLE,
        extras: { advisoryPriceId: id, reason: "extract_returned_null" },
      });
      return buildFallback(query);
    }
    // extractFirstTierPrice returns a string like "$0.0450/hour".
    // Tightened regex matches a single decimal number — `\d+(?:\.\d+)?`
    // rejects multi-dot captures that the previous `[\d.]+` would accept.
    const numericMatch = extracted.match(/\$(\d+(?:\.\d+)?)/);
    if (!numericMatch?.[1]) {
      log({
        ts: new Date().toISOString(),
        runId,
        level: "warn",
        action: LOG_ACTIONS.PRICING_UNAVAILABLE,
        extras: {
          advisoryPriceId: id,
          reason: "regex_no_match",
          extracted,
        },
      });
      return buildFallback(query);
    }
    const rawRate = Number.parseFloat(numericMatch[1]);
    if (!Number.isFinite(rawRate) || rawRate <= 0) {
      log({
        ts: new Date().toISOString(),
        runId,
        level: "warn",
        action: LOG_ACTIONS.PRICING_UNAVAILABLE,
        extras: {
          advisoryPriceId: id,
          reason: "non_positive_rate",
          rawRate,
        },
      });
      return buildFallback(query);
    }
    const value = query.convert ? query.convert(rawRate) : rawRate;
    return {
      value,
      label: formatLabelWithSource(query.format(value), "mcp"),
      source: "mcp",
    };
  } catch {
    log({
      ts: new Date().toISOString(),
      runId,
      level: "warn",
      action: LOG_ACTIONS.PRICING_UNAVAILABLE,
      extras: { advisoryPriceId: id, reason: "exception" },
    });
    return buildFallback(query);
  }
}

/**
 * Walk every entry in `ADVISORY_PRICE_QUERIES`, fetch each in parallel,
 * and return a populated map. Missing/empty `tools` short-circuits to
 * an all-fallback map without any MCP traffic — the call site never has
 * to special-case "no tools available".
 */
export async function enrichAdvisoryPrices(
  tools: StructuredTool[] | undefined,
  runId = "advisory-enricher",
): Promise<EnrichedPriceMap> {
  const map: EnrichedPriceMap = new Map();
  const pricingTool = tools?.find((t) => t.name === ToolName.GET_PRICING);
  if (!pricingTool) {
    // No tool → resolve every entry from the fallback constants.
    for (const id of ENRICHABLE_PRICE_IDS) {
      const query = ADVISORY_PRICE_QUERIES[id];
      if (query) map.set(id, buildFallback(query));
    }
    return map;
  }

  // Live path — fetch every price in parallel. Promise.allSettled isolates
  // per-query failures so one MCP timeout doesn't poison the others.
  const settled = await Promise.allSettled(
    ENRICHABLE_PRICE_IDS.map((id) => enrichOne(id, pricingTool, runId)),
  );
  ENRICHABLE_PRICE_IDS.forEach((id, i) => {
    const outcome = settled[i];
    if (outcome?.status === "fulfilled") {
      map.set(id, outcome.value);
    } else {
      // Defensive: enrichOne should never throw, but if a future change
      // regresses that we still ship a usable map.
      const query = ADVISORY_PRICE_QUERIES[id];
      if (query) map.set(id, buildFallback(query));
    }
  });
  return map;
}
