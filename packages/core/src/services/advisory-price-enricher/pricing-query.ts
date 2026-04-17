/**
 * Single-price enrichment via the Pricing MCP server.
 *
 * Never throws — every failure path resolves to a fulfilled fallback so
 * `Promise.allSettled` at the orchestrator level sees consistent values.
 *
 * Lifted from apps/cli/src/services/advisory-price-enricher/pricing-query.ts
 * in Story 50-4 Wave 5 Pass G.
 *
 * @see Story 46.3
 */

import {
  formatLabelWithSource,
  extractFirstTierPrice,
  type AwsPricingResponse,
} from "../../pricing/index.js";
import type { StructuredTool } from "@langchain/core/tools";
import { AWS_REGION } from "../../config/constants/aws.js";
import { PricingTerm } from "../../constants/pricing-api.js";
import { withTimeout } from "../../utils/timeout.js";
import { unwrapMcpText } from "../../utils/mcp.js";
import { log, LOG_ACTIONS } from "../../utils/logger/index.js";
import {
  AdvisoryPriceId,
  type EnrichedPrice,
} from "../../pricing/advisory-prices.js";
import { buildFallback } from "./fallback.js";
import { ADVISORY_PRICE_QUERIES, ENRICHMENT_TIMEOUT_MS } from "./types.js";

/**
 * Try to fetch one advisory price from the live Pricing MCP server.
 * Returns the enriched value on success, or the fallback on any failure.
 */
export async function enrichOne(
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
