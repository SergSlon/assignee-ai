/**
 * Low-level price query + cache wrapper + extractor.
 *
 * Extracted from pricing-lookup.ts (Wave 6d F5) to enforce SRP:
 *   - extractPrice: first-tier on-demand USD extraction from MCP response shape
 *   - queryPrice: MCP invoke with per-fetcher cache check + timeout + failure-silent fallback
 */
import type { StructuredTool } from "@langchain/core/tools";
import type { AwsPricingResponse } from "@assignee/core";
import { PricingMatchType } from "@assignee/core";
import { AWS_REGION, PricingCategory } from "../../config/constants.js";
import { PricingTerm } from "../../constants/pricing.js";
import { unwrapMcpText } from "../mcp.js";
import { withTimeout } from "../timeout.js";
import { getCachedPrice, setCachedPrice } from "../../services/price-cache.js";

export const LOOKUP_TIMEOUT_MS = 6000;

export type TermMatchFilter = {
  Field: string;
  Value: string;
  Type: typeof PricingMatchType.TERM_MATCH;
};

/** Extracts the lowest first-tier (beginRange=0) non-zero USD on-demand price. */
export function extractPrice(data: AwsPricingResponse): string | null {
  const items = data.data ?? [];
  for (const item of items) {
    const onDemand = Object.values(item.terms?.OnDemand ?? {});
    for (const term of onDemand) {
      const dims = Object.values(term.priceDimensions ?? {});
      for (const dim of dims) {
        if (dim.beginRange === "0") {
          const usd = parseFloat(dim.pricePerUnit?.USD ?? "0");
          if (usd > 0) {
            const decimals =
              usd >= 0.0001 ? 4 : Math.ceil(-Math.log10(usd)) + 3;
            return `$${usd.toFixed(decimals)}/hr`;
          }
        }
      }
    }
  }
  return null;
}

export async function queryPrice(
  pricingTool: StructuredTool,
  serviceCode: string,
  filters: TermMatchFilter[],
): Promise<string | null> {
  // Check cache first (Story 23.4 — avoid redundant MCP calls)
  const cached = getCachedPrice(serviceCode, filters, PricingCategory.COMPUTE);
  if (cached) {
    const data = cached as AwsPricingResponse;
    return extractPrice(data);
  }

  try {
    const result = await withTimeout(
      pricingTool.invoke({
        service_code: serviceCode,
        region: AWS_REGION,
        filters,
        output_options: { pricing_terms: [PricingTerm.ON_DEMAND] },
      }),
      LOOKUP_TIMEOUT_MS,
    );
    if (!result) return null;
    const data = JSON.parse(unwrapMcpText(result)) as AwsPricingResponse;
    setCachedPrice(serviceCode, filters, data);
    return extractPrice(data);
  } catch {
    return null;
  }
}
