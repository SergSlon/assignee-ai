/**
 * EC2 on-demand instance-type pricing fetcher.
 * Extracted from pricing-lookup.ts (Wave 6d F5).
 */
import type { StructuredTool } from "@langchain/core/tools";
import { PricingMatchType } from "@assignee/core";
import { ToolName } from "../../constants/tools.js";
import { PricingServiceCode, PricingFilter } from "../../constants/pricing.js";
import { queryPrice, type TermMatchFilter } from "./query.js";

/**
 * Fetches live on-demand prices for EC2 instance types in parallel.
 * Returns a map of instanceType → "$X.XXXX/hr" for each successfully priced type.
 */
export async function fetchEc2InstancePrices(
  tools: StructuredTool[],
  instanceTypes: string[],
): Promise<Record<string, string>> {
  const pricingTool = tools.find((t) => t.name === ToolName.GET_PRICING);
  if (!pricingTool) return {};

  const results = await Promise.all(
    instanceTypes.map(async (instanceType) => {
      const filters: TermMatchFilter[] = [
        {
          Field: PricingFilter.Field.PRODUCT_FAMILY,
          Value: PricingFilter.Value.EC2_PRODUCT_FAMILY,
          Type: PricingMatchType.TERM_MATCH,
        },
        {
          Field: PricingFilter.Field.INSTANCE_TYPE,
          Value: instanceType,
          Type: PricingMatchType.TERM_MATCH,
        },
        {
          Field: PricingFilter.Field.OPERATING_SYSTEM,
          Value: PricingFilter.Value.EC2_OS_LINUX,
          Type: PricingMatchType.TERM_MATCH,
        },
        {
          Field: PricingFilter.Field.TENANCY,
          Value: PricingFilter.Value.EC2_TENANCY_SHARED,
          Type: PricingMatchType.TERM_MATCH,
        },
        {
          Field: PricingFilter.Field.CAPACITY_STATUS,
          Value: PricingFilter.Value.EC2_CAPACITY_USED,
          Type: PricingMatchType.TERM_MATCH,
        },
        {
          Field: PricingFilter.Field.PRE_INSTALLED_SW,
          Value: PricingFilter.Value.EC2_NO_PREINSTALL,
          Type: PricingMatchType.TERM_MATCH,
        },
      ];
      const price = await queryPrice(
        pricingTool,
        PricingServiceCode.EC2,
        filters,
      );
      return [instanceType, price] as const;
    }),
  );

  return Object.fromEntries(
    results.filter((entry): entry is [string, string] => entry[1] !== null),
  );
}
