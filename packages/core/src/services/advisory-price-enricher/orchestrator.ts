/**
 * Parallel fan-out orchestrator for the advisory price enricher.
 *
 * Walks the registry, fetches each query in parallel, and returns a
 * populated map. Missing/empty `tools` short-circuits to an all-fallback
 * map without any MCP traffic.
 *
 * Story 94.N9 adds per-resource-type inner gating: when a `resourceType`
 * is provided we intersect `ENRICHABLE_PRICE_IDS` with
 * `getRelevantAdvisoryPriceIds(resourceType)` so a plan for NAT Gateway
 * does NOT fire the ALB / CW Alarm fetches (that produced noisy
 * `pricing_unavailable advisoryPriceId=alb-monthly` warnings on every
 * NAT / EFS / CloudWatch / EventBridge / CloudFront plan). The outer
 * gate in `advice-generator.ts` skips the call entirely for types that
 * consume no advisory prices; this inner gate covers the types that
 * consume SOME but not ALL enrichable prices.
 *
 * Lifted from apps/cli/src/services/advisory-price-enricher/orchestrator.ts
 * in Story 50-4 Wave 5 Pass G.
 *
 * @see Story 46.3
 * @see Story 92.1.e — outer gate (resource type → needs enrichment at all)
 * @see Story 94.N9 — inner gate (filter registry by relevant IDs)
 */

import type { StructuredTool } from "@langchain/core/tools";
import { ToolName } from "../../constants/tools.js";
import {
  getRelevantAdvisoryPriceIds,
  type AdvisoryPriceId,
  type EnrichedPriceMap,
} from "../../pricing/advisory-prices.js";
import { buildFallback } from "./fallback.js";
import { enrichOne } from "./pricing-query.js";
import { ADVISORY_PRICE_QUERIES, ENRICHABLE_PRICE_IDS } from "./types.js";

/**
 * Walk the registry, fetch each entry in parallel, and return a
 * populated map. Missing/empty `tools` short-circuits to an all-fallback
 * map without any MCP traffic — the call site never has to special-case
 * "no tools available".
 *
 * When `resourceType` is supplied, the fan-out is filtered to the
 * intersection of `ENRICHABLE_PRICE_IDS` and
 * `getRelevantAdvisoryPriceIds(resourceType)`. IDs that the resource
 * type's cost-advisor branch would never consume are skipped entirely —
 * no MCP call, no fallback entry. Omitting `resourceType` preserves the
 * original behavior (fan out to every enrichable ID).
 */
export async function enrichAdvisoryPrices(
  tools: StructuredTool[] | undefined,
  runId = "advisory-enricher",
  resourceType?: string,
): Promise<EnrichedPriceMap> {
  const targetIds = resolveTargetIds(resourceType);
  const map: EnrichedPriceMap = new Map();
  if (targetIds.length === 0) {
    // Resource type is known and consumes no enrichable advisory
    // prices — return an empty map so cost-advisor's `enrichedLabel`
    // synthesizes "(estimated)" fallbacks locally.
    return map;
  }

  const pricingTool = tools?.find((t) => t.name === ToolName.GET_PRICING);
  if (!pricingTool) {
    // No tool → resolve every target entry from the fallback constants.
    for (const id of targetIds) {
      const query = ADVISORY_PRICE_QUERIES[id];
      if (query) map.set(id, buildFallback(query));
    }
    return map;
  }

  // Live path — fetch every target price in parallel. Promise.allSettled
  // isolates per-query failures so one MCP timeout doesn't poison the
  // others.
  const settled = await Promise.allSettled(
    targetIds.map((id) => enrichOne(id, pricingTool, runId)),
  );
  targetIds.forEach((id, i) => {
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

/**
 * Compute which enrichable IDs to fetch for the given resource type.
 * When `resourceType` is undefined we fall back to the full enrichable
 * set (back-compat for callers that don't pass a type). When it's
 * defined the registry is filtered by the per-type relevance table —
 * an unknown or advisory-price-free type produces an empty list so the
 * caller can bail before allocating a tool lookup.
 */
function resolveTargetIds(
  resourceType: string | undefined,
): readonly AdvisoryPriceId[] {
  if (resourceType === undefined) return ENRICHABLE_PRICE_IDS;
  const relevant = getRelevantAdvisoryPriceIds(resourceType);
  return ENRICHABLE_PRICE_IDS.filter((id) => relevant.has(id));
}
