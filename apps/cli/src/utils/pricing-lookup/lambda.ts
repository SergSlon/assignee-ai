/**
 * Lambda GB-second pricing fetcher for x86 + arm architectures.
 * Extracted from pricing-lookup.ts (Wave 6d F5).
 */
import type { StructuredTool } from "@langchain/core/tools";
import { PricingMatchType } from "@assignee/core";
import { ToolName } from "../../constants/tools.js";
import { PricingServiceCode, PricingFilter } from "../../constants/pricing.js";
import { queryPrice, type TermMatchFilter } from "./query.js";

/**
 * Fetches live on-demand Lambda GB-second prices for both x86_64
 * and arm64 architectures in a single parallel MCP round-trip.
 * Returns `{ x86: "$0.0000166667/hr", arm: "$0.0000133334/hr" }`
 * (with the "hr" suffix preserved because extractPrice() stamps
 * one for every MCP response — the caller strips it before doing
 * GB-second math).
 */
export async function fetchLambdaArchPrices(
  tools: StructuredTool[],
): Promise<{ x86?: string; arm?: string }> {
  const pricingTool = tools.find((t) => t.name === ToolName.GET_PRICING);
  if (!pricingTool) return {};

  const baseFilters: TermMatchFilter[] = [
    {
      Field: PricingFilter.Field.PRODUCT_FAMILY,
      Value: PricingFilter.Value.LAMBDA_PRODUCT_FAMILY,
      Type: PricingMatchType.TERM_MATCH,
    },
  ];

  const [x86, arm] = await Promise.all([
    queryPrice(pricingTool, PricingServiceCode.LAMBDA, [
      ...baseFilters,
      {
        Field: PricingFilter.Field.USAGE_TYPE,
        Value: "Lambda-GB-Second",
        Type: PricingMatchType.TERM_MATCH,
      },
    ]),
    queryPrice(pricingTool, PricingServiceCode.LAMBDA, [
      ...baseFilters,
      {
        Field: PricingFilter.Field.USAGE_TYPE,
        Value: "Lambda-GB-Second-ARM",
        Type: PricingMatchType.TERM_MATCH,
      },
    ]),
  ]);

  const result: { x86?: string; arm?: string } = {};
  if (x86) result.x86 = x86;
  if (arm) result.arm = arm;
  return result;
}
