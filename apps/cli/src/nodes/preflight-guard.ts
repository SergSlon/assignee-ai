/**
 * preflight_guard node — cost estimation + basic validation gate.
 * Pricing query has a 3s hard timeout (non-blocking: never blocks apply on failure).
 * SaaS policy validation is Epic 4; POC always passes.
 *
 * @see Story 1-7
 */

import { ExecutionStatus } from "@assignee/core";
import type { StructuredTool } from "@langchain/core/tools";
import { ToolName } from "../constants/tools.js";
import { AWS_REGION } from "../config/constants.js";
import { log, LOG_ACTIONS } from "../utils/logger.js";
import { unwrapMcpText } from "../utils/mcp.js";
import type { AgentState } from "../services/graph.js";

const PRICING_TIMEOUT_MS = 3000;

interface PricingConfig {
  serviceCode: string;
  /** AWS Pricing API filters to narrow to the relevant SKU */
  filters: Array<{ Field: string; Value: string; Type: "TERM_MATCH" }>;
  /** Human-readable unit label appended to the price, e.g. "/GB-month" */
  unit: string;
}

/** Maps resource type → pricing query config (or "Free" to skip). */
const PRICING_CONFIG: Record<string, PricingConfig | "Free"> = {
  "AWS::S3::Bucket": {
    serviceCode: "AmazonS3",
    filters: [
      { Field: "productFamily", Value: "Storage", Type: "TERM_MATCH" },
      { Field: "usagetype", Value: "TimedStorage-ByteHrs", Type: "TERM_MATCH" },
    ],
    unit: "/GB-month",
  },
  "AWS::SSM::Parameter": {
    serviceCode: "AWSSystemsManager",
    filters: [
      {
        Field: "productFamily",
        Value: "AWS Systems Manager",
        Type: "TERM_MATCH",
      },
    ],
    unit: "/param-hour",
  },
  "AWS::IAM::Role": "Free",
};

/** Extracts the lowest first-tier (beginRange=0) non-zero price from a get_pricing response. */
function extractFirstTierPrice(
  data: Record<string, unknown>,
  unit: string,
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
          if (usd > 0) return `$${usd.toFixed(4)}${unit}`;
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

  const pricingConfig = PRICING_CONFIG[state.resourceType];
  let costEstimate = "N/A";

  if (pricingConfig === "Free") {
    costEstimate = "Free";
  } else if (pricingConfig && tools) {
    const pricingTool = tools.find((t) => t.name === ToolName.GET_PRICING);
    if (pricingTool) {
      try {
        const timeout = new Promise<null>((resolve) =>
          setTimeout(() => resolve(null), PRICING_TIMEOUT_MS),
        );
        const query = pricingTool.invoke({
          service_code: pricingConfig.serviceCode,
          region: AWS_REGION,
          filters: pricingConfig.filters,
          output_options: { pricing_terms: ["OnDemand"] },
        });
        const result = await Promise.race([query, timeout]);
        if (result !== null) {
          const data = JSON.parse(unwrapMcpText(result)) as Record<
            string,
            unknown
          >;
          costEstimate =
            extractFirstTierPrice(data, pricingConfig.unit) ?? "N/A";
        }
        // null means timeout — leave costEstimate as 'N/A'
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
