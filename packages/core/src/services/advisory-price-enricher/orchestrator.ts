/**
 * Parallel fan-out orchestrator for the advisory price enricher.
 *
 * Walks every entry in `ADVISORY_PRICE_QUERIES`, fetches each in
 * parallel, and returns a populated map. Missing/empty `tools`
 * short-circuits to an all-fallback map without any MCP traffic.
 *
 * Lifted from apps/cli/src/services/advisory-price-enricher/orchestrator.ts
 * in Story 50-4 Wave 5 Pass G.
 *
 * @see Story 46.3
 */

import type { StructuredTool } from "@langchain/core/tools";
import { ToolName } from "../../constants/tools.js";
import type { EnrichedPriceMap } from "../../pricing/advisory-prices.js";
import { buildFallback } from "./fallback.js";
import { enrichOne } from "./pricing-query.js";
import { ADVISORY_PRICE_QUERIES, ENRICHABLE_PRICE_IDS } from "./types.js";

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
