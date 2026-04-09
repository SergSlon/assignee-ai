/**
 * Live pricing lookup utilities for the option-elicitor node.
 * Fetches real-time on-demand instance prices from the AWS Pricing API MCP server
 * and returns a map of optionValue → "$X.XXXX/hr".
 *
 * Failures (timeout, API error, missing tool) are silent — callers fall back
 * to the static hint labels already embedded in the plugin option definitions.
 */

import type { StructuredTool } from "@langchain/core/tools";
import type { AwsPricingResponse } from "@assignee/core";
import {
  PricingMatchType,
  RdsEngineDisplay,
  RdsEngineId,
} from "@assignee/core";
import { ToolName } from "../constants/tools.js";
import { AWS_REGION, PricingCategory } from "../config/constants.js";
import {
  PricingServiceCode,
  PricingFilter,
  PricingTerm,
} from "../constants/pricing.js";
import { unwrapMcpText } from "./mcp.js";
import { withTimeout } from "./timeout.js";
import { getCachedPrice, setCachedPrice } from "../services/price-cache.js";

const LOOKUP_TIMEOUT_MS = 6000;

type TermMatchFilter = {
  Field: string;
  Value: string;
  Type: typeof PricingMatchType.TERM_MATCH;
};

/** Extracts the lowest first-tier (beginRange=0) non-zero USD on-demand price. */
function extractPrice(data: AwsPricingResponse): string | null {
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

async function queryPrice(
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
      ]);
      return [instanceType, price] as const;
    }),
  );

  return Object.fromEntries(
    results.filter((entry): entry is [string, string] => entry[1] !== null),
  );
}

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
 * Fetches live on-demand Lambda GB-second prices for both x86_64
 * and arm64 architectures in a single parallel MCP round-trip.
 * Returns `{ x86: "$0.0000166667/hr", arm: "$0.0000133334/hr" }`
 * (with the "hr" suffix preserved because extractPrice() stamps
 * one for every MCP response — the caller strips it before doing
 * GB-second math).
 *
 * The Pricing MCP filter uses `usagetype=Lambda-GB-Second` for
 * x86 and `usagetype=Lambda-GB-Second-ARM` for arm64 — both under
 * the same `productFamily=Serverless` root. This mirrors the
 * existing lambda decomposer's x86 query shape.
 *
 * @see A7 follow-up — Lambda architecture rightsizing
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

/**
 * Fetches the live on-demand CloudWatch Logs Standard-class storage
 * rate (per GB-month). Returns a string like `"$0.03/hr"` (the
 * extractPrice helper stamps the `/hr` suffix regardless of the
 * actual unit — callers strip it). Used by the cost-optimizer's
 * `analyzeLogsLogGroup` retention recommendation.
 *
 * The Pricing MCP product family is "Storage Snapshot" (shared with
 * CW alarm metric storage) and the usage type is
 * "CW:DataStorage-Bytes" for the Standard log class. Infrequent
 * Access storage bills under a separate usagetype and is ~half the
 * price — the analyzer targets Standard because that's the default
 * and the one where missing retention causes the biggest leak.
 *
 * @see (f) 2026-04-09 Task 8 — Epic 32 CW Logs retention slice
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
