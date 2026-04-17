/**
 * Single-line headline pricing:
 * - Starts from the local strategy (always available, cheap).
 * - Overlays the live MCP `get_pricing` response when available.
 *
 * Source semantics (Story 46.2):
 *   "mcp"       — live AWS Pricing API response extracted successfully.
 *   "free"      — local strategy authoritatively says free-tier.
 *   "fallback"  — local strategy estimate when MCP unavailable/timeout/
 *                 returned an unextractable payload.
 */
import type { StructuredTool } from "@langchain/core/tools";
import {
  defaultPricingRegistry,
  extractFirstTierPrice,
  type AwsPricingResponse,
  type DataSource,
} from "@assignee/core";
import { AWS_REGION } from "../../../../config/constants/aws.js";
import { PRICING_TIMEOUT_MS } from "../../../../config/constants/timeouts.js";
import { PricingTerm } from "../../../../constants/pricing-api.js";
import { ToolName } from "../../../../constants/tools.js";
import { log, LOG_ACTIONS } from "../../../../utils/logger/index.js";
import { unwrapMcpText } from "../../../../utils/mcp.js";
import { withTimeout } from "../../../../utils/timeout.js";

export interface HeadlinePricing {
  label: string;
  source: DataSource;
}

export function getLocalHeadline(
  resourceType: string,
  desiredState: Record<string, unknown>,
): HeadlinePricing {
  const local = defaultPricingRegistry.estimate(resourceType, desiredState);
  return { label: local.label, source: local.source };
}

/**
 * Query MCP for a single-line headline price. Always returns — falls back
 * to the local estimate on timeout, parse failure, or missing tool.
 */
export async function queryHeadlinePricing(
  resourceType: string,
  desiredState: Record<string, unknown>,
  tools: StructuredTool[] | undefined,
  runId: string,
  localHeadline: HeadlinePricing,
): Promise<HeadlinePricing> {
  const mcpConfig = defaultPricingRegistry.getMcpConfig(
    resourceType,
    desiredState,
  );
  if (!mcpConfig || !tools) return localHeadline;
  const pricingTool = tools.find((t) => t.name === ToolName.GET_PRICING);
  if (!pricingTool) return localHeadline;
  try {
    const timeoutMs = mcpConfig.timeoutMs ?? PRICING_TIMEOUT_MS;
    const result = await withTimeout(
      pricingTool.invoke({
        service_code: mcpConfig.serviceCode,
        region: AWS_REGION,
        filters: mcpConfig.filters,
        output_options: { pricing_terms: [PricingTerm.ON_DEMAND] },
      }),
      timeoutMs,
    );
    if (result === null) {
      log({
        ts: new Date().toISOString(),
        runId,
        level: "warn",
        action: LOG_ACTIONS.PRICING_TIMEOUT,
        extras: { resourceType, timeoutMs },
      });
      return localHeadline;
    }
    const data = JSON.parse(unwrapMcpText(result)) as AwsPricingResponse;
    const extracted = extractFirstTierPrice(
      data,
      mcpConfig.unit,
      mcpConfig.scale,
    );
    if (extracted !== null) return { label: extracted, source: "mcp" };
    return localHeadline;
  } catch {
    log({
      ts: new Date().toISOString(),
      runId,
      level: "warn",
      action: LOG_ACTIONS.PRICING_UNAVAILABLE,
      extras: { resourceType },
    });
    return localHeadline;
  }
}
