/**
 * Decomposer-driven pricing breakdown (Story 23.6).
 *
 * For resource types registered in `defaultDecomposerRegistry`, the
 * decomposer yields an array of pricing line items. Each is resolved in
 * parallel via MCP — with price-cache lookup (Story 23.4) to avoid
 * redundant calls.
 *
 * `hasCacheHits` feeds the headline source picker so the display layer
 * can report "cached" vs "mcp" honestly (Story 46.2).
 *
 * Concurrency is bounded to `PRICING_CONCURRENCY` (5) to prevent
 * rate-limit spikes on large plans (M-α-21 / W13-S3).
 */

import type { StructuredTool } from "@langchain/core/tools";
import {
  defaultDecomposerRegistry,
  extractFirstTierPrice,
  type AwsPricingResponse,
  type PricingBreakdown,
  type PricingLineItem,
  type PricingLineItemResult,
} from "@/index.js";
import { AWS_REGION } from "@/config/constants/aws.js";
import { PRICING_TIMEOUT_MS } from "@/config/constants/timeouts.js";
import { HOURS_PER_MONTH } from "@/config/constants/limits.js";
import { PricingTerm } from "@/constants/pricing-api.js";
import { ToolName } from "@/constants/tools.js";
import { log, LOG_ACTIONS } from "@/utils/logger/index.js";
import { unwrapMcpText } from "@/utils/mcp.js";
import { withTimeout } from "@/utils/timeout.js";
import { getCachedPrice, setCachedPrice } from "@/services/price-cache.js";

/**
 * Maximum number of concurrent `get_pricing` MCP calls issued at once.
 * Matches the schema-warmer concurrency cap in CloudFormationSchemaService.
 * Export allows tests to assert the cap and future tuning in one place.
 */
export const PRICING_CONCURRENCY = 5;

export interface DecomposerOutcome {
  /**
   * True when the decomposer fired and returned an empty line-item list —
   * i.e. the resource is explicitly free for this configuration (SSM
   * Standard-tier parameters, ECS clusters with default capacity, etc.).
   */
  decomposerReportedFree: boolean;
  breakdown?: PricingBreakdown;
}

export async function runDecomposerBreakdown(
  resourceType: string,
  desiredState: Record<string, unknown>,
  tools: StructuredTool[] | undefined,
  runId: string,
  projectDir?: string,
): Promise<DecomposerOutcome> {
  if (!defaultDecomposerRegistry.has(resourceType)) {
    return { decomposerReportedFree: false };
  }
  const lineItems = defaultDecomposerRegistry.decompose(
    resourceType,
    desiredState,
  );
  if (lineItems.length === 0) {
    return { decomposerReportedFree: true };
  }
  if (!tools) return { decomposerReportedFree: false };
  const breakdown = await queryLineItemPrices(
    lineItems,
    tools,
    runId,
    projectDir,
  );
  return { decomposerReportedFree: false, breakdown };
}

/**
 * Query MCP for each pricing line item in parallel (Story 23.6).
 * Uses price cache (Story 23.4) to avoid redundant queries.
 */
export async function queryLineItemPrices(
  lineItems: PricingLineItem[],
  tools: StructuredTool[],
  runId: string,
  projectDir?: string,
): Promise<PricingBreakdown> {
  const pricingTool = tools.find((t) => t.name === ToolName.GET_PRICING);
  const fetchedAt = new Date().toISOString().split("T")[0]!;
  let hasPartialFailure = false;
  let hasCacheHits = false;

  // Process line items in bounded batches to avoid rate-limiting (M-α-21 / W13-S3).
  // Each batch is processed with Promise.all; batches are sequential so at most
  // PRICING_CONCURRENCY calls are in-flight simultaneously.
  const results: PricingLineItemResult[] = [];
  for (let i = 0; i < lineItems.length; i += PRICING_CONCURRENCY) {
    const batch = lineItems.slice(i, i + PRICING_CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map(async (item): Promise<PricingLineItemResult> => {
        if (!pricingTool) {
          hasPartialFailure = true;
          return {
            lineItem: item,
            unitPrice: null,
            monthlyCost: null,
            displayPrice: "unavailable",
          };
        }

        const category =
          item.kind === "fixed" && item.priceUnit === "/hr"
            ? "compute"
            : "storage";
        const cached = getCachedPrice(
          item.serviceCode,
          item.filters,
          category,
          projectDir,
        );

        try {
          let data: AwsPricingResponse;

          if (cached) {
            data = cached as AwsPricingResponse;
            hasCacheHits = true;
          } else {
            const timeoutMs = item.timeoutMs ?? PRICING_TIMEOUT_MS;
            const result = await withTimeout(
              pricingTool.invoke({
                service_code: item.serviceCode,
                region: AWS_REGION,
                filters: item.filters,
                output_options: { pricing_terms: [PricingTerm.ON_DEMAND] },
              }),
              timeoutMs,
            );

            if (result === null) {
              hasPartialFailure = true;
              return {
                lineItem: item,
                unitPrice: null,
                monthlyCost: null,
                displayPrice: "unavailable",
              };
            }

            data = JSON.parse(unwrapMcpText(result)) as AwsPricingResponse;
            setCachedPrice(item.serviceCode, item.filters, data);
          }

          const priceStr = extractFirstTierPrice(
            data,
            item.priceUnit,
            item.scale,
            item.filters,
          );

          if (!priceStr) {
            log({
              ts: new Date().toISOString(),
              runId: "system",
              level: "warn",
              action: LOG_ACTIONS.PREFLIGHT_COMPLETED,
              extras: {
                priceUnavailable: item.label,
                serviceCode: item.serviceCode,
                responseItems: data.data?.length ?? 0,
              },
            });
            hasPartialFailure = true;
            return {
              lineItem: item,
              unitPrice: null,
              monthlyCost: null,
              displayPrice: "unavailable",
            };
          }

          let monthlyCost: number | null = null;
          const rawPrice = parseFloat(priceStr.replace(/[$,]/g, ""));

          if (item.kind === "fixed" && !isNaN(rawPrice)) {
            if (item.priceUnit === "/hr") {
              monthlyCost = rawPrice * HOURS_PER_MONTH * item.quantity;
            } else if (item.priceUnit.includes("/GB-mo")) {
              monthlyCost = rawPrice * item.quantity;
            } else {
              monthlyCost = rawPrice * item.quantity;
            }
          }

          const displayPrice =
            monthlyCost !== null
              ? `$${monthlyCost.toFixed(2)}/mo`
              : `${priceStr}`;

          return {
            lineItem: item,
            unitPrice: priceStr,
            monthlyCost,
            displayPrice,
          };
        } catch {
          hasPartialFailure = true;
          log({
            ts: new Date().toISOString(),
            runId,
            level: "warn",
            action: LOG_ACTIONS.PRICING_UNAVAILABLE,
            extras: { lineItem: item.label, serviceCode: item.serviceCode },
          });
          return {
            lineItem: item,
            unitPrice: null,
            monthlyCost: null,
            displayPrice: "unavailable",
          };
        }
      }),
    );
    results.push(...batchResults);
  }

  const fixedItems = results.filter((r) => r.lineItem.kind === "fixed");
  const usageBasedItems = results.filter(
    (r) => r.lineItem.kind === "usage_based",
  );
  const fixedSubtotal = fixedItems.reduce(
    (sum, r) => sum + (r.monthlyCost ?? 0),
    0,
  );

  return {
    fixedItems,
    usageBasedItems,
    fixedSubtotal,
    fetchedAt,
    hasPartialFailure,
    hasCacheHits,
  };
}
