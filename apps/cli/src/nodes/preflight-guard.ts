/**
 * preflight_guard node — cost estimation + basic validation gate.
 * Pricing query has a 3s hard timeout (non-blocking: never blocks apply on failure).
 * SaaS policy validation is Epic 4; POC always passes.
 *
 * @see Story 1-7
 */

import { ExecutionStatus, RESOURCE_TYPES } from "@assignee/core";
import type { StructuredTool } from "@langchain/core/tools";
import { ToolName } from "../constants/tools.js";
import { AWS_REGION } from "../config/constants.js";
import {
  PricingServiceCode,
  PricingFilter,
  PricingUnit,
  PricingScale,
  PricingDefault,
} from "../constants/pricing.js";
import { log, LOG_ACTIONS } from "../utils/logger.js";
import { unwrapMcpText } from "../utils/mcp.js";
import type { AgentState } from "../services/graph.js";

const PRICING_TIMEOUT_MS = 3000;
const PRICING_TIMEOUT_EXTENDED_MS = 8000;

interface PricingConfig {
  serviceCode: string;
  /** AWS Pricing API filters to narrow to the relevant SKU */
  filters: Array<{ Field: string; Value: string; Type: "TERM_MATCH" }>;
  /** Human-readable unit label appended to the price, e.g. "/GB-month" */
  unit: string;
  /** Multiply the raw API price before display (e.g. 1_000_000 to convert /GB-sec → /million GB-sec) */
  scale?: number;
  /** Override the default 3s timeout for resource types with larger SKU catalogs */
  timeoutMs?: number;
}

type PricingProvider =
  | PricingConfig
  | "Free"
  | ((state: AgentState) => PricingConfig | undefined);

/** Maps resource type → static config, "Free", or a function that reads desiredState. */
const PRICING_CONFIG: Record<string, PricingProvider> = {
  [RESOURCE_TYPES.S3_BUCKET]: {
    serviceCode: PricingServiceCode.S3,
    filters: [
      {
        Field: PricingFilter.Field.PRODUCT_FAMILY,
        Value: PricingFilter.Value.S3_STORAGE,
        Type: "TERM_MATCH",
      },
      {
        Field: PricingFilter.Field.USAGE_TYPE,
        Value: PricingFilter.Value.S3_USAGE_TYPE,
        Type: "TERM_MATCH",
      },
    ],
    unit: PricingUnit.GB_MONTH,
  },
  [RESOURCE_TYPES.SSM_PARAMETER]: {
    serviceCode: PricingServiceCode.SSM,
    filters: [
      {
        Field: PricingFilter.Field.PRODUCT_FAMILY,
        Value: PricingFilter.Value.SSM_PRODUCT_FAMILY,
        Type: "TERM_MATCH",
      },
    ],
    unit: PricingUnit.PARAM_HOUR,
  },
  [RESOURCE_TYPES.IAM_ROLE]: "Free",
  [RESOURCE_TYPES.EC2_INSTANCE]: (state) => {
    const ds = (state.desiredState ?? {}) as Record<string, string>;
    const instanceType = ds["InstanceType"] ?? PricingDefault.EC2_INSTANCE_TYPE;
    return {
      serviceCode: PricingServiceCode.EC2,
      filters: [
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
      ],
      unit: PricingUnit.HOUR,
      timeoutMs: PRICING_TIMEOUT_EXTENDED_MS,
    };
  },
  [RESOURCE_TYPES.RDS_DB_INSTANCE]: (state) => {
    const ds = (state.desiredState ?? {}) as Record<string, string>;
    const instanceClass =
      ds["DBInstanceClass"] ?? PricingDefault.RDS_INSTANCE_CLASS;
    const engine = ds["Engine"] ?? PricingDefault.RDS_ENGINE;
    return {
      serviceCode: PricingServiceCode.RDS,
      filters: [
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
      ],
      unit: PricingUnit.HOUR,
      timeoutMs: PRICING_TIMEOUT_EXTENDED_MS,
    };
  },
  // Lambda omitted: cost depends on memory × avg duration — cannot estimate without runtime data.
  // Story 7.1 resource plugin will compute this from desiredState.MemorySize + assumed avg duration.
};

/** Extracts the lowest first-tier (beginRange=0) non-zero price from a get_pricing response. */
function extractFirstTierPrice(
  data: Record<string, unknown>,
  unit: string,
  scale = 1,
): string | null {
  const items = (data["data"] as unknown[]) ?? [];
  for (const item of items) {
    const onDemand = (item as Record<string, unknown>)?.["terms"] as
      | Record<string, unknown>
      | undefined;
    const terms = Object.values(
      (onDemand?.["OnDemand"] as Record<string, unknown>) ?? {},
    );
    for (const term of terms) {
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
            const scaled = usd * scale;
            const decimals =
              scaled >= 0.0001 ? 4 : Math.ceil(-Math.log10(scaled)) + 3;
            return `$${scaled.toFixed(decimals)}${unit}`;
          }
        }
      }
    }
  }
  return null;
}

export async function preflightGuardNode(
  state: AgentState,
  tools?: StructuredTool[],
): Promise<Partial<AgentState>> {
  if (state.executionStatus !== ExecutionStatus.PENDING) return {};

  const provider = PRICING_CONFIG[state.resourceType];
  const pricingConfig =
    typeof provider === "function" ? provider(state) : provider;
  let costEstimate = "N/A";

  if (pricingConfig === "Free") {
    costEstimate = "Free";
  } else if (pricingConfig && tools) {
    const pricingTool = tools.find((t) => t.name === ToolName.GET_PRICING);
    if (pricingTool) {
      try {
        const timeoutMs = pricingConfig.timeoutMs ?? PRICING_TIMEOUT_MS;
        const timeout = new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), timeoutMs),
        );
        const query = pricingTool.invoke({
          service_code: pricingConfig.serviceCode,
          region: AWS_REGION,
          filters: pricingConfig.filters,
          output_options: { pricing_terms: ["OnDemand"] },
        });
        const result = await Promise.race([query, timeout]);
        if (result === null) {
          log({
            ts: new Date().toISOString(),
            runId: state.runId,
            level: "warn",
            action: LOG_ACTIONS.PRICING_TIMEOUT,
            resourceType: state.resourceType,
            timeoutMs,
          });
        } else {
          const data = JSON.parse(unwrapMcpText(result)) as Record<
            string,
            unknown
          >;
          costEstimate =
            extractFirstTierPrice(
              data,
              pricingConfig.unit,
              pricingConfig.scale,
            ) ?? "N/A";
        }
      } catch {
        // Non-blocking: pricing failure never blocks the plan
        log({
          ts: new Date().toISOString(),
          runId: state.runId,
          level: "warn",
          action: LOG_ACTIONS.PRICING_UNAVAILABLE,
          resourceType: state.resourceType,
        });
      }
    }
  }

  log({
    ts: new Date().toISOString(),
    runId: state.runId,
    level: "info",
    action: LOG_ACTIONS.PREFLIGHT_COMPLETED,
    costEstimate,
    resourceType: state.resourceType,
  });

  return {
    estimatedMonthlyCost: costEstimate,
    preflightPassed: true,
  };
}
