/**
 * Pricing-MCP enricher for `assignee list`
 * (feature-pricing-mcp-list-enrichment).
 *
 * Resolves live rate-card cost estimates for resource rows whose
 * `estimatedMonthlyCost` is still N/A after provision-log and billing
 * enrichment. Consumes the existing pricing decomposers from
 * `packages/core/src/pricing/decomposers/` via `defaultDecomposerRegistry`.
 *
 * Batching: one Pricing MCP call per unique (resourceType, region) tuple —
 * 22 KMS keys in us-east-1 → 1 MCP call, not 22.
 *
 * Failure semantics: per-tuple failure → no entry in returned Map (rows
 * stay N/A) + ONE stderr warning per tuple. Never throws.
 *
 * @see breakdown.ts for the plan-time equivalent of this logic.
 */

import type { StructuredTool } from "@langchain/core/tools";
import {
  MultiServerMCPClient,
  type ClientConfig,
} from "@langchain/mcp-adapters";
import { getMcpServerConfigs } from "../config/mcp-servers.js";
import { defaultDecomposerRegistry } from "../pricing/barrels/decomposers.js";
import { extractFirstTierPrice } from "../pricing/mcp-parser.js";
import { unwrapMcpText } from "../utils/mcp.js";
import { McpServerName } from "../constants/mcp.js";
import { ToolName } from "../constants/tools.js";
import { PricingTerm } from "../constants/pricing-api.js";
import { PricingKind } from "../pricing/filter-constants.js";
import { HOURS_PER_MONTH } from "../config/constants/limits.js";
import type { PricingEnricher } from "./fetch-managed-resources.js";
import type { ManagedResource } from "./types.js";
import type { AwsPricingResponse } from "../pricing/types.js";

/** Timeout per Pricing MCP call in milliseconds. */
const PRICING_MCP_TIMEOUT_MS = 15_000;

/** Label for a resource that has no charge (free tier or zero-cost types). */
const ZERO_COST_LABEL = "$0/mo";

/** Maximum retry attempts for throttled Pricing MCP calls. */
const PRICING_MAX_RETRIES = 3;

/** Base backoff delay in ms (jittered exponential). */
const PRICING_RETRY_BASE_MS = 250;

/**
 * Returns true if the error indicates an AWS/MCP rate-limit or throttle.
 */
function isThrottlingError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("429") ||
    msg.toLowerCase().includes("throttling") ||
    msg.toLowerCase().includes("rate exceeded") ||
    msg.toLowerCase().includes("rate limit") ||
    msg.toLowerCase().includes("too many requests")
  );
}

/**
 * Retries `fn` up to `maxAttempts` times on throttling errors using
 * jittered exponential back-off (baseMs * 2^attempt ± jitter).
 */
async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = PRICING_MAX_RETRIES,
  baseMs = PRICING_RETRY_BASE_MS,
): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isThrottlingError(err) || attempt === maxAttempts - 1) throw err;
      const delay =
        baseMs * Math.pow(2, attempt) + Math.floor(Math.random() * 100);
      await new Promise((res) => setTimeout(res, delay));
    }
  }
  throw lastErr;
}

/**
 * Wraps a Promise with a timeout. Clears the timer when the inner promise
 * settles to avoid event-loop handle leaks (F#13).
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<T>((_, reject) => {
    handle = setTimeout(() => reject(new Error("Pricing MCP timeout")), ms);
  });
  return Promise.race([promise, timer]).finally(() => {
    if (handle !== undefined) clearTimeout(handle);
  });
}

/**
 * Returns true when the pricing response explicitly reports a $0.00 rate
 * (i.e., has at least one OnDemand priceDimension with USD = "0").
 *
 * `extractFirstTierPrice` skips zero prices (usd > 0 guard), so we check
 * for the genuine-zero case separately (F#6).
 */
function hasExplicitZeroPrice(data: AwsPricingResponse): boolean {
  for (const item of data.data ?? []) {
    const onDemandTerms = Object.values(item.terms?.OnDemand ?? {});
    for (const term of onDemandTerms) {
      const dims = Object.values(term.priceDimensions ?? {});
      for (const dim of dims) {
        const usd = parseFloat(dim.pricePerUnit?.["USD"] ?? "");
        if (!isNaN(usd) && usd === 0) return true;
      }
    }
  }
  return false;
}

/**
 * Hardened unwrapMcpText that also handles array-wrapped MCP responses.
 * Shapes handled:
 *   (a) string                          → JSON.stringify(s)
 *   (b) { type:"text", text: string }   → text
 *   (c) [{ type:"text", text: string }] → first element's text
 *   (d) anything else                   → JSON.stringify(val)
 */
function unwrapPricingMcpText(response: unknown): string {
  // (c) Array-wrapped — take first element
  if (Array.isArray(response)) {
    if (response.length === 0) {
      throw new Error(
        "Pricing MCP returned an empty array response — cannot parse.",
      );
    }
    return unwrapMcpText(response[0]);
  }
  // (a), (b), (d) — delegate to the shared helper
  return unwrapMcpText(response);
}

/**
 * Formats a PricingBreakdown result into a human-readable cost label for
 * the `assignee list` table. Priority:
 *  1. decomposerReportedFree → "$0/mo"
 *  2. fixedSubtotal >= 0 AND at least one fixed item resolved → "$X.XX/mo"
 *     (>= so a genuine $0.00/mo promotional rate is displayed, not hidden)
 *  3. Only usage-based items → first item's displayPrice (rate label)
 *  4. Unavailable → undefined (caller leaves row as N/A)
 */
function formatCostLabel(breakdown: {
  fixedSubtotal: number;
  fixedItems: Array<{ monthlyCost: number | null; displayPrice: string }>;
  usageBasedItems: Array<{ displayPrice: string }>;
  decomposerReportedFree: boolean;
  anyFixedResolved: boolean;
}): string | undefined {
  if (breakdown.decomposerReportedFree) {
    return ZERO_COST_LABEL;
  }

  // F#6: use >= 0 so genuine $0.00/mo is displayed (not filtered as falsy).
  // Guard: only emit the zero label when at least one fixed item DID resolve;
  // if nothing resolved we can't distinguish "$0.00 promo" from "all failed".
  if (breakdown.anyFixedResolved && breakdown.fixedSubtotal >= 0) {
    return `$${breakdown.fixedSubtotal.toFixed(2)}/mo`;
  }

  // Some resources (e.g. KMS) have both fixed and usage-based items.
  // If fixed subtotal is truthy we already returned above; if there are
  // fixed items that reported "unavailable" and none resolved, stay N/A.
  const hasFailedFixed = breakdown.fixedItems.some(
    (r) => r.displayPrice === "unavailable",
  );
  if (!breakdown.anyFixedResolved && hasFailedFixed) {
    return undefined; // pricing unavailable — leave N/A
  }

  // For usage-based services (CloudFront, S3 data transfer, Lambda invocations),
  // surface the first resolved usage-based rate as a display hint.
  const firstUsageBased = breakdown.usageBasedItems.find(
    (r) => r.displayPrice !== "unavailable",
  );
  if (firstUsageBased) {
    return firstUsageBased.displayPrice;
  }

  return undefined;
}

/**
 * Bootstrap a short-lived Pricing MCP client, extract the `get_pricing`
 * tool, execute the callback, then close the client.
 */
async function withPricingTool<T>(
  callback: (tool: StructuredTool) => Promise<T>,
): Promise<T> {
  const allServerConfigs = getMcpServerConfigs();
  const pricingConfig = allServerConfigs[McpServerName.PRICING];

  if (!pricingConfig) {
    throw new Error(
      "Pricing MCP server is not configured (reader credentials missing).",
    );
  }

  const clientConfig: ClientConfig = {
    mcpServers: {
      [McpServerName.PRICING]: {
        transport: "stdio" as const,
        command: pricingConfig.command,
        args: pricingConfig.args,
        env: pricingConfig.env,
        stderr: "pipe" as const,
      },
    },
  };

  const mcpClient = new MultiServerMCPClient(clientConfig);
  await mcpClient.initializeConnections();

  try {
    const tools = await mcpClient.getTools();
    const pricingTool = tools.find((t) => t.name === ToolName.GET_PRICING);
    if (!pricingTool) {
      throw new Error("get_pricing tool not found in Pricing MCP server.");
    }
    return await callback(pricingTool);
  } finally {
    await mcpClient.close().catch(() => {
      // Ignore close errors — don't let cleanup mask real failures.
    });
  }
}

/**
 * Factory that returns a `PricingEnricher` for the `assignee list` command.
 * The enricher:
 * 1. Bootstraps a short-lived Pricing MCP client.
 * 2. Groups input resources by (resourceType, region).
 * 3. For each unique tuple, calls `decompose()` on the registry + issues ONE
 *    Pricing MCP call per line item (via existing `queryLineItemPrices` shape).
 * 4. Formats results into a summary cost label string.
 * 5. Closes the MCP client after the full batch.
 */
export function createListPricingEnricher(): PricingEnricher {
  return async (resources: ManagedResource[]): Promise<Map<string, string>> => {
    const result = new Map<string, string>();

    // Filter to resources with a registered decomposer
    const priceable = resources.filter(
      (r) => r.arn && defaultDecomposerRegistry.has(r.resourceType),
    );

    if (priceable.length === 0) return result;

    // Group by (resourceType, region) for caching / deduplication
    type TupleKey = `${string}::${string}`;
    const grouped = new Map<TupleKey, ManagedResource[]>();
    for (const r of priceable) {
      // Global resources → use "us-east-1" for Pricing API (same as plan path)
      const effectiveRegion = r.region === "global" ? "us-east-1" : r.region;
      const key: TupleKey = `${r.resourceType}::${effectiveRegion}`;
      const bucket = grouped.get(key) ?? [];
      bucket.push(r);
      grouped.set(key, bucket);
    }

    try {
      await withPricingTool(async (pricingTool) => {
        // Process each (resourceType, region) tuple sequentially to respect
        // Pricing MCP rate limits. Within a tuple, all ARNs share the same
        // cost label (same type + region = same rate card).
        for (const [key, group] of grouped) {
          try {
            const resourceType = group[0]!.resourceType;
            // The TupleKey is "<resourceType>::<region>". Resource types
            // contain "::" themselves (e.g. "AWS::KMS::Key"), so split("::")[1]
            // would return "KMS" instead of the region. Use .pop() (last
            // segment) to correctly extract the region component.
            const keyParts = key.split("::");
            const effectiveRegion = keyParts[keyParts.length - 1]!;

            // Synthesise minimal desiredState for the decomposer
            const desiredState: Record<string, unknown> =
              buildMinimalDesiredState(resourceType);

            const lineItems = defaultDecomposerRegistry.decompose(
              resourceType,
              desiredState,
            );

            if (lineItems.length === 0) {
              // Free resource (e.g. VPC, Subnet, IAM Role)
              for (const r of group) {
                if (r.arn) result.set(r.arn, ZERO_COST_LABEL);
              }
              continue;
            }

            // Query MCP for each line item (fixed items only for summary)
            const fixedItems = lineItems.filter(
              (i) => i.kind === PricingKind.FIXED,
            );
            const usageBasedItems = lineItems.filter(
              (i) => i.kind === PricingKind.USAGE_BASED,
            );

            let fixedSubtotal = 0;
            let anyFixedResolved = false;
            const fixedResults: Array<{
              monthlyCost: number | null;
              displayPrice: string;
            }> = [];
            const usageResults: Array<{ displayPrice: string }> = [];

            // Resolve fixed items — F#2: track whether any item in this tuple failed
            let tupleHadAnyFailure = false;
            for (const item of fixedItems) {
              try {
                // F#4: retry on 429/throttle with exponential back-off
                // F#4: retry on 429/throttle with exponential back-off
                const rawResult = await withRetry(() =>
                  withTimeout(
                    pricingTool.invoke({
                      service_code: item.serviceCode,
                      region: effectiveRegion,
                      filters: item.filters,
                      output_options: {
                        pricing_terms: [PricingTerm.ON_DEMAND],
                      },
                    }),
                    PRICING_MCP_TIMEOUT_MS,
                  ),
                );

                if (rawResult === null) {
                  fixedResults.push({
                    monthlyCost: null,
                    displayPrice: "unavailable",
                  });
                  tupleHadAnyFailure = true;
                  continue;
                }

                // F#7: harden response unwrapping to handle array-wrapped shapes
                const data = JSON.parse(
                  unwrapPricingMcpText(rawResult),
                ) as AwsPricingResponse;
                const priceStr = extractFirstTierPrice(
                  data,
                  item.priceUnit,
                  item.scale,
                  item.filters,
                );

                if (!priceStr) {
                  // F#6: check for genuine $0.00 price before declaring unavailable
                  if (hasExplicitZeroPrice(data)) {
                    fixedResults.push({
                      monthlyCost: 0,
                      displayPrice: "$0.00/mo",
                    });
                    anyFixedResolved = true;
                    // fixedSubtotal stays 0 — correct
                  } else {
                    fixedResults.push({
                      monthlyCost: null,
                      displayPrice: "unavailable",
                    });
                    tupleHadAnyFailure = true;
                  }
                  continue;
                }

                const rawPrice = parseFloat(priceStr.replace(/[$,]/g, ""));
                let monthlyCost: number | null = null;
                if (!isNaN(rawPrice)) {
                  if (item.priceUnit === "/hr") {
                    monthlyCost = rawPrice * HOURS_PER_MONTH * item.quantity;
                  } else {
                    monthlyCost = rawPrice * item.quantity;
                  }
                }

                if (monthlyCost !== null) {
                  fixedSubtotal += monthlyCost;
                  anyFixedResolved = true;
                  fixedResults.push({
                    monthlyCost,
                    displayPrice: `$${monthlyCost.toFixed(2)}/mo`,
                  });
                } else {
                  fixedResults.push({
                    monthlyCost: null,
                    displayPrice: priceStr,
                  });
                  anyFixedResolved = true;
                }
              } catch {
                fixedResults.push({
                  monthlyCost: null,
                  displayPrice: "unavailable",
                });
                tupleHadAnyFailure = true;
              }
            }

            // F#2: emit exactly ONE stderr warning per tuple where any item failed
            if (tupleHadAnyFailure) {
              process.stderr.write(
                `⚠ Warning: Pricing MCP enrichment partially failed for ${key} — some line items unavailable.\n`,
              );
            }

            // Resolve first usage-based item (for rate display hint)
            if (usageBasedItems.length > 0 && fixedSubtotal === 0) {
              const item = usageBasedItems[0]!;
              try {
                // F#4: retry on throttle
                const rawResult = await withRetry(() =>
                  withTimeout(
                    pricingTool.invoke({
                      service_code: item.serviceCode,
                      region: effectiveRegion,
                      filters: item.filters,
                      output_options: {
                        pricing_terms: [PricingTerm.ON_DEMAND],
                      },
                    }),
                    PRICING_MCP_TIMEOUT_MS,
                  ),
                );

                if (rawResult !== null) {
                  // F#7: harden response unwrapping
                  const data = JSON.parse(
                    unwrapPricingMcpText(rawResult),
                  ) as AwsPricingResponse;
                  const priceStr = extractFirstTierPrice(
                    data,
                    item.priceUnit,
                    item.scale,
                    item.filters,
                  );
                  if (priceStr) {
                    usageResults.push({
                      displayPrice: `${priceStr}${item.priceUnit}`,
                    });
                  }
                }
              } catch {
                // Ignore usage-based failures — fixed cost already handled
              }
            }

            const label = formatCostLabel({
              fixedSubtotal,
              fixedItems: fixedResults,
              usageBasedItems: usageResults,
              decomposerReportedFree: false,
              anyFixedResolved,
            });

            if (label !== undefined) {
              for (const r of group) {
                if (r.arn) result.set(r.arn, label);
              }
            }
          } catch (err) {
            // Per-tuple failure — warn once, leave rows as N/A
            process.stderr.write(
              `⚠ Warning: Pricing MCP enrichment failed for ${key}: ${
                err instanceof Error ? err.message : String(err)
              }\n`,
            );
          }
        }
      });
    } catch (err) {
      // Pricing MCP client bootstrap failed (missing creds, server down, etc.)
      process.stderr.write(
        `⚠ Warning: Pricing MCP enrichment skipped: ${
          err instanceof Error ? err.message : String(err)
        }\n`,
      );
    }

    return result;
  };
}

/**
 * Synthesises a minimal `desiredState` for a decomposer call from a bare
 * resource type. Most decomposers accept an empty object; a few require
 * specific fields to avoid returning empty line-item arrays.
 */
function buildMinimalDesiredState(
  resourceType: string,
): Record<string, unknown> {
  switch (resourceType) {
    case "AWS::KMS::Key":
      // KMS decomposer uses KeySpec to distinguish symmetric vs asymmetric
      // request fees; symmetric ($0.03/10K) is the common case.
      return { KeySpec: "SYMMETRIC_DEFAULT" };
    case "AWS::CloudFront::Distribution":
      // CloudFront decomposer ignores desiredState (returns 2 usage-based items)
      return { DistributionConfig: { PriceClass: "PriceClass_All" } };
    default:
      return {};
  }
}
