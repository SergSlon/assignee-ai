/**
 * RDS on-demand instance-class pricing fetcher, including Aurora special-casing.
 * Extracted from pricing-lookup.ts (Wave 6d F5).
 */
import type { StructuredTool } from "@langchain/core/tools";
import {
  PricingMatchType,
  RdsEngineDisplay,
  RdsEngineId,
} from "@assignee/core";
import { ToolName } from "../../constants/tools.js";
import { PricingServiceCode, PricingFilter } from "../../constants/pricing.js";
import { queryPrice, type TermMatchFilter } from "./query.js";

/**
 * Maps plugin engine values (as defined in rds-dbinstance.ts) to the engine
 * names expected by the AWS Pricing API.
 */
const RDS_ENGINE_API_NAME: Record<string, string> = {
  mysql: RdsEngineDisplay.MYSQL,
  postgres: RdsEngineDisplay.POSTGRESQL,
  mariadb: RdsEngineDisplay.MARIADB,
  [RdsEngineId.AURORA_MYSQL]: RdsEngineDisplay.AURORA_MYSQL,
  [RdsEngineId.AURORA_POSTGRESQL]: RdsEngineDisplay.AURORA_POSTGRESQL,
};

/** Aurora engines use a different pricing SKU structure — no deploymentOption filter. */
const AURORA_ENGINES: Set<string> = new Set([
  RdsEngineId.AURORA_MYSQL,
  RdsEngineId.AURORA_POSTGRESQL,
]);

/**
 * Fetches live on-demand prices for RDS DB instance classes in parallel.
 * Maps plugin engine values to AWS Pricing API names automatically.
 * Aurora engines omit the deploymentOption filter (not applicable for Aurora).
 * Returns a map of instanceClass → "$X.XXXX/hr" for each successfully priced class.
 */
export async function fetchRdsInstancePrices(
  tools: StructuredTool[],
  instanceClasses: string[],
  engine: string,
): Promise<Record<string, string>> {
  const pricingTool = tools.find((t) => t.name === ToolName.GET_PRICING);
  if (!pricingTool) return {};

  const apiEngine = RDS_ENGINE_API_NAME[engine] ?? engine;
  const isAurora = AURORA_ENGINES.has(engine);

  const results = await Promise.all(
    instanceClasses.map(async (instanceClass) => {
      const filters: TermMatchFilter[] = [
        {
          Field: PricingFilter.Field.PRODUCT_FAMILY,
          Value: PricingFilter.Value.RDS_PRODUCT_FAMILY,
          Type: PricingMatchType.TERM_MATCH,
        },
        {
          Field: PricingFilter.Field.INSTANCE_TYPE,
          Value: instanceClass,
          Type: PricingMatchType.TERM_MATCH,
        },
        {
          Field: PricingFilter.Field.DATABASE_ENGINE,
          Value: apiEngine,
          Type: PricingMatchType.TERM_MATCH,
        },
      ];

      if (!isAurora) {
        filters.push({
          Field: PricingFilter.Field.DEPLOYMENT_OPTION,
          Value: PricingFilter.Value.RDS_SINGLE_AZ,
          Type: PricingMatchType.TERM_MATCH,
        });
      }

      const price = await queryPrice(
        pricingTool,
        PricingServiceCode.RDS,
        filters,
      );
      return [instanceClass, price] as const;
    }),
  );

  return Object.fromEntries(
    results.filter((entry): entry is [string, string] => entry[1] !== null),
  );
}
