/**
 * CloudWatch Logs storage pricing fetcher.
 * Extracted from pricing-lookup.ts (Wave 6d F5).
 */
import type { StructuredTool } from "@langchain/core/tools";
import {
  PricingMatchType,
  PricingServiceCode,
} from "../../pricing/filter-constants.js";
import { ToolName } from "../../constants/tools.js";
import { PricingFilter } from "../../constants/pricing-api.js";
import { queryPrice } from "./query.js";

/**
 * Fetches the live on-demand CloudWatch Logs Standard-class storage
 * rate (per GB-month). Returns a string like `"$0.03/hr"` (the
 * extractPrice helper stamps the `/hr` suffix regardless of the
 * actual unit — callers strip it). Used by the cost-optimizer's
 * `analyzeLogsLogGroup` retention recommendation.
 */
export async function fetchCwLogsStoragePrice(
  tools: StructuredTool[],
): Promise<string | null> {
  const pricingTool = tools.find((t) => t.name === ToolName.GET_PRICING);
  if (!pricingTool) return null;

  return await queryPrice(pricingTool, PricingServiceCode.CLOUDWATCH, [
    {
      Field: PricingFilter.Field.PRODUCT_FAMILY,
      Value: PricingFilter.Value.CLOUDWATCH_STORAGE_SNAPSHOT,
      Type: PricingMatchType.TERM_MATCH,
    },
    {
      Field: PricingFilter.Field.USAGE_TYPE,
      Value: PricingFilter.Value.CW_LOG_STORAGE_STANDARD_USAGE_TYPE,
      Type: PricingMatchType.TERM_MATCH,
    },
  ]);
}
