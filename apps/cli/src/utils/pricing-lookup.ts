/**
 * Live pricing lookup utilities for the option-elicitor node.
 * Fetches real-time on-demand instance prices from the AWS Pricing API MCP server
 * and returns a map of optionValue → "$X.XXXX/hr".
 *
 * Failures (timeout, API error, missing tool) are silent — callers fall back
 * to the static hint labels already embedded in the plugin option definitions.
 */

import type { StructuredTool } from "@langchain/core/tools";
import { ToolName } from "../constants/tools.js";
import { AWS_REGION } from "../config/constants.js";
import { PricingServiceCode, PricingFilter } from "../constants/pricing.js";
import { unwrapMcpText } from "./mcp.js";

const LOOKUP_TIMEOUT_MS = 6000;

type TermMatchFilter = { Field: string; Value: string; Type: "TERM_MATCH" };

/** Extracts the lowest first-tier (beginRange=0) non-zero USD on-demand price. */
function extractPrice(data: Record<string, unknown>): string | null {
  const items = (data["data"] as unknown[]) ?? [];
  for (const item of items) {
    const terms = (item as Record<string, unknown>)?.["terms"] as
      | Record<string, unknown>
      | undefined;
    const onDemand = Object.values(
      (terms?.["OnDemand"] as Record<string, unknown>) ?? {},
    );
    for (const term of onDemand) {
      const dims = Object.values(
        ((term as Record<string, unknown>)?.["priceDimensions"] as Record<
          string,
          unknown
        >) ?? {},
      );
      for (const dim of dims) {
        const d = dim as Record<string, unknown>;
        if (d["beginRange"] === "0") {
          const usd = parseFloat(
            (d["pricePerUnit"] as Record<string, string>)?.["USD"] ?? "0",
          );
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

async function queryPrice(
  pricingTool: StructuredTool,
  serviceCode: string,
  filters: TermMatchFilter[],
): Promise<string | null> {
  try {
    const timeout = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), LOOKUP_TIMEOUT_MS),
    );
    const query = pricingTool.invoke({
      service_code: serviceCode,
      region: AWS_REGION,
      filters,
      output_options: { pricing_terms: ["OnDemand"] },
    });
    const result = await Promise.race([query, timeout]);
    if (!result) return null;
    const data = JSON.parse(unwrapMcpText(result)) as Record<string, unknown>;
    return extractPrice(data);
  } catch {
    return null;
  }
}

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
      const price = await queryPrice(pricingTool, PricingServiceCode.EC2, [
        {
          Field: PricingFilter.Field.PRODUCT_FAMILY,
          Value: PricingFilter.Value.EC2_PRODUCT_FAMILY,
          Type: "TERM_MATCH",
        },
        {
          Field: PricingFilter.Field.INSTANCE_TYPE,
          Value: instanceType,
          Type: "TERM_MATCH",
        },
        {
          Field: PricingFilter.Field.OPERATING_SYSTEM,
          Value: PricingFilter.Value.EC2_OS_LINUX,
          Type: "TERM_MATCH",
        },
        {
          Field: PricingFilter.Field.TENANCY,
          Value: PricingFilter.Value.EC2_TENANCY_SHARED,
          Type: "TERM_MATCH",
        },
        {
          Field: PricingFilter.Field.CAPACITY_STATUS,
          Value: PricingFilter.Value.EC2_CAPACITY_USED,
          Type: "TERM_MATCH",
        },
        {
          Field: PricingFilter.Field.PRE_INSTALLED_SW,
          Value: PricingFilter.Value.EC2_NO_PREINSTALL,
          Type: "TERM_MATCH",
        },
      ]);
      return [instanceType, price] as const;
    }),
  );

  return Object.fromEntries(
    results.filter((entry): entry is [string, string] => entry[1] !== null),
  );
}

/**
 * Fetches live on-demand Single-AZ prices for RDS DB instance classes in parallel.
 * Uses the provided engine name (AWS pricing API value, e.g. "postgres").
 * Returns a map of instanceClass → "$X.XXXX/hr" for each successfully priced class.
 */
export async function fetchRdsInstancePrices(
  tools: StructuredTool[],
  instanceClasses: string[],
  engine: string,
): Promise<Record<string, string>> {
  const pricingTool = tools.find((t) => t.name === ToolName.GET_PRICING);
  if (!pricingTool) return {};

  const results = await Promise.all(
    instanceClasses.map(async (instanceClass) => {
      const price = await queryPrice(pricingTool, PricingServiceCode.RDS, [
        {
          Field: PricingFilter.Field.PRODUCT_FAMILY,
          Value: PricingFilter.Value.RDS_PRODUCT_FAMILY,
          Type: "TERM_MATCH",
        },
        {
          Field: PricingFilter.Field.INSTANCE_TYPE,
          Value: instanceClass,
          Type: "TERM_MATCH",
        },
        {
          Field: PricingFilter.Field.DATABASE_ENGINE,
          Value: engine,
          Type: "TERM_MATCH",
        },
        {
          Field: PricingFilter.Field.DEPLOYMENT_OPTION,
          Value: PricingFilter.Value.RDS_SINGLE_AZ,
          Type: "TERM_MATCH",
        },
      ]);
      return [instanceClass, price] as const;
    }),
  );

  return Object.fromEntries(
    results.filter((entry): entry is [string, string] => entry[1] !== null),
  );
}
