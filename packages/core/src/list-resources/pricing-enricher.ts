/**
 * Pricing-MCP enricher for `assignee admin list`
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
import {
  extractFirstTierPrice,
  extractTieredPrice,
} from "../pricing/mcp-parser.js";
import { unwrapMcpText } from "../utils/mcp.js";
import { McpServerName } from "../constants/mcp.js";
import { ToolName } from "../constants/tools.js";
import { PricingTerm } from "../constants/pricing-api.js";
import {
  PricingField,
  PricingKind,
  PricingMatchType,
  PricingProductFamily,
  PricingServiceCode,
} from "../pricing/filter-constants.js";
import { PricingFilterValue } from "../pricing/pricing-filter-values.js";
import { HOURS_PER_MONTH } from "../config/constants/limits.js";
import {
  S3StorageClass,
  type PricingEnricher,
  type StorageEnricher,
  type ResourceUsage,
} from "./fetch-managed-resources.js";
import type { ManagedResource } from "./types.js";
import type { AwsPricingResponse, McpPricingFilter } from "../pricing/types.js";
import type { PriceTier } from "../pricing/tier-ladder.js";
import { PriceUnit } from "../pricing/price-units.js";
import { RESOURCE_TYPES } from "../config/resource-types.js";

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
 * the `assignee admin list` table. Priority:
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
 * Factory that returns a `PricingEnricher` for the `assignee admin list` command.
 * The enricher:
 * 1. Bootstraps a short-lived Pricing MCP client.
 * 2. Optionally calls the supplied `storageEnricher` to collect actual
 *    storage GB / usage volumes for in-scope resources (S3 today). When
 *    present, per-GB-month usage-based line items are multiplied by the
 *    actual GB volume and promoted to fixed-cost lines (closes F6).
 *    For S3 buckets that span multiple storage classes (lifecycle-tiered
 *    Standard → IA → Glacier), per-class rates are fetched in parallel
 *    via the per-class MCP cache (F6-ITEM-3 / Quinn H1) so the
 *    `$X.XX/mo` total sums the right per-class rate for each present
 *    class. The cache is keyed by (region, class) so 100 buckets in
 *    one region with two classes each → 2 MCP calls per pass total,
 *    NOT 200.
 * 3. Groups input resources by (resourceType, region).
 * 4. For each unique tuple, calls `decompose()` on the registry + issues ONE
 *    Pricing MCP call per line item (via existing `queryLineItemPrices` shape).
 * 5. Formats results into a summary cost label string.
 * 6. Closes the MCP client after the full batch.
 *
 * @param storageEnricher  Optional usage-lookup callback. When omitted the
 *   enricher behaves exactly as it did before F6 — per-GB-month rates surface
 *   as their displayPrice hint string (e.g. `"$0.0230/GB-month"`). When
 *   supplied and returning a non-empty `storageByClass` for an S3 bucket
 *   ARN, each present class is multiplied by its class-specific per-GB
 *   rate (single MCP call per (region, class) tuple, cached for the
 *   pass) and the sum contributes to a numeric `$X.XX/mo` total.
 *   Glacier-Flexible-Retrieval buckets carry an `≈` prefix on the
 *   total to flag the retrieval-tier ambiguity (the per-GB rate maps
 *   to a single number but the live cost depends on Standard /
 *   Expedited / Bulk retrievals).
 */
export function createListPricingEnricher(
  storageEnricher?: StorageEnricher,
): PricingEnricher {
  return async (resources: ManagedResource[]): Promise<Map<string, string>> => {
    const result = new Map<string, string>();

    // Filter to resources with a registered decomposer FIRST so we
    // don't pay the storage-enricher cost (per-bucket CloudWatch call)
    // for empty / non-priceable inputs. Quinn M2.
    const priceable = resources.filter(
      (r) => r.arn && defaultDecomposerRegistry.has(r.resourceType),
    );

    if (priceable.length === 0) return result;

    // Storage / usage lookup is per-resource (not per-tuple) — fetch
    // once up-front so the per-tuple loop below can reach into it
    // without re-querying. Failures inside the enricher are swallowed
    // there (per its contract); an empty map just disables the F6
    // promotion path and falls back to the rate-hint display.
    let usageByArn: Map<string, ResourceUsage> = new Map();
    if (storageEnricher) {
      try {
        usageByArn = await storageEnricher(priceable);
      } catch (err) {
        // Defensive — `StorageEnricher` contract says never-throws but
        // we don't want a misbehaving implementation to kill pricing.
        process.stderr.write(
          `⚠ Warning: storage-enricher threw, falling back to rate-only display: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
      }
    }

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

    // F6-ITEM-3 (Quinn H1 closure): per-class S3 storage rate cache. Keyed
    // by `${region}::${S3StorageClass}`. The pricing-enricher closes the
    // MCP client at the end of the call, so this cache lives for the
    // duration of one enrichment pass (typically one `assignee admin list`
    // / `infra destroy --all` invocation). Per-tuple semantics: 100 buckets
    // in us-east-1 hitting Standard + IA → 2 MCP calls total, NOT 200.
    // 100 buckets across 5 regions hitting Standard + IA → 10 MCP calls
    // (`5 regions × 2 classes`), NOT 1000. Worst case (all 7 classes,
    // every region) = `7 × region-count` MCP calls per pass, not
    // `7 × bucket-count`. See `getPerClassS3Rate` for the fetch /
    // memoise / null-cache contract.
    const s3StorageRateCache = new Map<string, number | null>();
    const s3StorageRateUnavailableCache = new Set<string>();

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

            // ── CloudFront F6 promotion (2026-05-25) ──────────────
            // CloudFront's rate-card is fundamentally different from
            // every other resource type: 100% usage-based, with a
            // TIERED per-GB data-transfer ladder and a per-request
            // rate. The shared "extract first usage-based rate as
            // hint" path returned `$0.085/GB` for every distribution
            // regardless of actual traffic. The CloudFront branch
            // pulls `Requests` + `BytesDownloaded` from the usage map
            // (populated by the CloudWatch usage-enricher) and
            // computes `(requests × rate) + tieredCost(bytes)` per
            // distribution.
            if (resourceType === RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION) {
              await enrichCloudFrontGroup({
                group,
                effectiveRegion,
                pricingTool,
                usageByArn,
                result,
              });
              continue;
            }

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
            // F6: usageResults now carries the parsed per-unit rate alongside
            // the displayPrice string so per-resource storage cost can be
            // computed in the assignment loop below when a StorageEnricher
            // supplies actual GB.
            const usageResults: Array<{
              displayPrice: string;
              ratePerUnit?: number;
              priceUnit?: string;
            }> = [];

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
                    // DF-COST-LABEL-DDB-DESTROY-DUP (live verify 2026-05-12):
                    // extractFirstTierPrice already returns
                    // `$<scaled><priceUnit>` (e.g. `$0.0000001250/M read reqs`)
                    // because it appends `${unit}` itself. The previous
                    // template here re-appended `${item.priceUnit}`,
                    // producing the doubled suffix observed on
                    // `assignee infra destroy <ddb-table-arn>`:
                    //   "Estimated savings: $0.0000001250/M read reqs/M read reqs saved"
                    // Push priceStr directly — the unit is already in there.
                    // F6: also parse the numeric rate so per-resource cost
                    // can be computed when StorageEnricher supplies actual
                    // GB volume. priceStr has shape "$X.XXXX/<unit>"; strip
                    // the prefix `$` and trailing `/<unit>` then parseFloat.
                    const numericPart = priceStr
                      .replace(/^\$/, "")
                      .replace(/\/.*$/, "");
                    const parsedRate = parseFloat(numericPart);
                    usageResults.push({
                      displayPrice: priceStr,
                      ...(Number.isFinite(parsedRate)
                        ? { ratePerUnit: parsedRate }
                        : {}),
                      priceUnit: item.priceUnit,
                    });
                  }
                }
              } catch {
                // Ignore usage-based failures — fixed cost already handled
              }
            }

            // F6: per-resource label assignment. The tuple-shared rate is
            // captured in fixedSubtotal + usageResults; per-resource usage
            // (storage GB) lets us promote a per-GB-month rate-hint into a
            // numeric $/mo total. Resources without usage data fall through
            // to the original tuple-shared label.
            const storageRate = usageResults.find(
              (u) =>
                u.ratePerUnit !== undefined &&
                (u.priceUnit === PriceUnit.PER_GB_MONTH ||
                  u.priceUnit === "/GB-month"),
            );

            for (const r of group) {
              if (!r.arn) continue;

              const usage = usageByArn.get(r.arn);
              const storageByClass = usage?.storageByClass;

              // F6 promotion path: known per-class GB + per-class
              // per-GB-month rates → compute a real $/mo storage line
              // item that contributes to fixedSubtotal, flip
              // anyFixedResolved so formatCostLabel emits the
              // "$X.XX/mo" branch instead of the rate-hint fallback.
              //
              // Two sub-paths:
              //   (a) Multi-class S3 (F6-ITEM-3): iterate every class
              //       present in `storageByClass`, look up the
              //       per-class rate via the per-region/class MCP
              //       cache, sum `classGB × classRate`. The Standard
              //       class re-uses the already-resolved `storageRate`
              //       (captured by the existing usage-based first-item
              //       path) to avoid an extra MCP call for buckets
              //       that only have Standard data.
              //   (b) Single dimension that isn't S3-multi-class
              //       (legacy generic resource types): the
              //       `storageByClass` field is undefined, fall
              //       through to the existing rate-hint display.
              //
              // Contract for partial MCP failure: if some classes
              // resolve and others throw, we still surface the
              // partial sum (subject to a > 50% failure rate threshold
              // below). The omitted classes get logged via the
              // pre-existing per-tuple stderr warning so the operator
              // can see why the total is conservative.
              let perResourceFixedSubtotal = fixedSubtotal;
              let perResourceAnyFixed = anyFixedResolved;

              if (storageByClass !== undefined) {
                const presentClasses = Object.entries(storageByClass)
                  .filter(([, gb]) => gb !== undefined && gb > 0)
                  .map(([cls, gb]) => [cls as S3StorageClass, gb!] as const);

                if (presentClasses.length > 0) {
                  // Per-class fan-out. Pre-resolved `storageRate`
                  // (from the usage-based first-item path above) only
                  // applies to the Standard class — for every other
                  // class we go through the per-class MCP cache.
                  let multiClassSum = 0;
                  let resolvedCount = 0;
                  let failedCount = 0;
                  for (const [cls, gb] of presentClasses) {
                    const rate = await getPerClassS3Rate({
                      cls,
                      region: effectiveRegion,
                      pricingTool,
                      rateCache: s3StorageRateCache,
                      unavailableCache: s3StorageRateUnavailableCache,
                      standardClassPreResolvedRate:
                        cls === S3StorageClass.STANDARD
                          ? storageRate?.ratePerUnit
                          : undefined,
                    });
                    if (rate === undefined || rate === null) {
                      failedCount++;
                      continue;
                    }
                    multiClassSum += rate * gb;
                    resolvedCount++;
                  }

                  // Contract: surface a partial sum so long as at
                  // least HALF of the present classes resolved.
                  // Below that, fall back to the rate-hint display —
                  // a sum built from fewer than half the classes
                  // would understate the total more misleadingly
                  // than a rate hint that at least says "we have a
                  // ladder of per-GB rates here, results may vary".
                  if (
                    resolvedCount > 0 &&
                    resolvedCount >= presentClasses.length - failedCount &&
                    resolvedCount * 2 >= presentClasses.length
                  ) {
                    perResourceFixedSubtotal += multiClassSum;
                    perResourceAnyFixed = true;
                    // Glacier-tier ambiguity disclaimer: every
                    // Glacier (non-IR) bucket carries the ≈ prefix
                    // because the per-GB rate-card lists ONE number
                    // but the user may be paying for Standard /
                    // Expedited / Bulk retrievals at different
                    // rates + the retrieval fee. The CLI doesn't
                    // call `GetBucketLifecycleConfiguration` per
                    // bucket today (would be one extra SDK call per
                    // Glacier bucket). Surface `≈` so the displayed
                    // $/mo reads as an estimate.
                    const containsGlacierFlexible = presentClasses.some(
                      ([cls]) => cls === S3StorageClass.GLACIER,
                    );
                    const label = formatCostLabel({
                      fixedSubtotal: perResourceFixedSubtotal,
                      fixedItems: fixedResults,
                      usageBasedItems: usageResults,
                      decomposerReportedFree: false,
                      anyFixedResolved: perResourceAnyFixed,
                    });
                    if (label !== undefined) {
                      result.set(
                        r.arn,
                        containsGlacierFlexible
                          ? prefixApproxIfMoneyLabel(label)
                          : label,
                      );
                    }
                    continue;
                  }
                }
              }

              const label = formatCostLabel({
                fixedSubtotal: perResourceFixedSubtotal,
                fixedItems: fixedResults,
                usageBasedItems: usageResults,
                decomposerReportedFree: false,
                anyFixedResolved: perResourceAnyFixed,
              });

              if (label !== undefined) {
                result.set(r.arn, label);
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
    // F6-ITEM-2 (Quinn HIGH-1): CloudFront decomposer ignores
    // desiredState entirely — the prior `PriceClass_All` synthesised
    // value was dead code. PriceClass-aware per-edge rate selection
    // requires an extra `cloudfront:GetDistributionConfig` call per
    // distribution and is tracked as F6-followup.
    default:
      return {};
  }
}

/**
 * Canonical per-class Pricing API `usagetype` filter values used by the
 * F6-ITEM-3 (Quinn H1) multi-class S3 promotion path. The keys match the
 * `S3StorageClass` enum so the per-class fan-out joins by enum value.
 *
 * The values are the UNPREFIXED `usagetype` strings — real Pricing API
 * responses prepend a region/edge token (e.g. `USE1-` for us-east-1,
 * `EU-` for eu-west-1). The prefix-aware `attributeValueMatches`
 * (F6-ITEM-1) strips that before equality comparison so this canonical
 * map matches every region. See `pricing-filter-values.ts` for the
 * SoT constants this map references.
 *
 * Glacier handling note: this map points the GLACIER (Flexible
 * Retrieval) class at `TimedStorage-GlacierByteHrs` — the
 * baseline-storage rate published per the AWS Pricing API for the
 * `STANDARD → GLACIER` lifecycle transition. The per-GB rate ignores
 * the three retrieval-pattern sub-tiers (Standard / Expedited /
 * Bulk) which carry separate per-GB-retrieved + per-request fees.
 * The pricing-enricher prefixes the resulting $/mo with `≈` when a
 * Glacier (non-IR) class is present to flag the disambiguation gap;
 * exact rates would require a per-bucket `GetBucketAnalyticsConfig`
 * round-trip which is tracked as a future enhancement.
 */
const S3_CLASS_TO_USAGETYPE: Record<S3StorageClass, string> = {
  [S3StorageClass.STANDARD]: PricingFilterValue.TIMED_STORAGE_BYTE_HRS,
  [S3StorageClass.STANDARD_IA]: PricingFilterValue.TIMED_STORAGE_SIA_BYTE_HRS,
  [S3StorageClass.ONE_ZONE_IA]: PricingFilterValue.TIMED_STORAGE_ZIA_BYTE_HRS,
  [S3StorageClass.INTELLIGENT_TIERING_FA]:
    PricingFilterValue.TIMED_STORAGE_INT_BYTE_HRS_FREQ,
  [S3StorageClass.GLACIER_IR]: PricingFilterValue.TIMED_STORAGE_GIR_BYTE_HRS,
  [S3StorageClass.GLACIER]: PricingFilterValue.TIMED_STORAGE_GLACIER_BYTE_HRS,
  [S3StorageClass.DEEP_ARCHIVE]: PricingFilterValue.TIMED_STORAGE_GDA_BYTE_HRS,
};

/**
 * Per-class per-region S3 storage rate lookup.
 *
 * Caching contract (Quinn H1 cost-bound):
 *   - Hits the `rateCache` first. Key = `${region}::${cls}` (lowercase
 *     class enum value). 100 buckets in us-east-1 with Standard + IA
 *     populated → 2 MCP calls total across the entire enrichment pass.
 *   - On cache miss, the unavailableCache (negative cache) is checked
 *     to avoid retrying a known-failed (region, class) tuple.
 *   - On both miss + cache-clean, dispatches ONE Pricing MCP call with
 *     a per-class `usagetype` filter (via `S3_CLASS_TO_USAGETYPE`).
 *     Success → rate stored in `rateCache`. Failure → entry added to
 *     `unavailableCache` and `null` returned.
 *
 * Standard-class fast path: when `standardClassPreResolvedRate` is
 * passed in, we use it directly without an MCP call. The pre-existing
 * usage-based first-item path in the tuple loop already resolves the
 * Standard rate for free (Standard is the FIRST usage-based item in
 * the S3 decomposer); reusing that value preserves the
 * "1 MCP call per Standard-only tuple" invariant from the pre-F6-ITEM-3
 * behaviour.
 */
async function getPerClassS3Rate(args: {
  cls: S3StorageClass;
  region: string;
  pricingTool: StructuredTool;
  rateCache: Map<string, number | null>;
  unavailableCache: Set<string>;
  standardClassPreResolvedRate?: number;
}): Promise<number | null | undefined> {
  const { cls, region, pricingTool, rateCache, unavailableCache } = args;
  // Fast path: re-use Standard rate the existing flow already resolved.
  if (
    cls === S3StorageClass.STANDARD &&
    args.standardClassPreResolvedRate !== undefined &&
    Number.isFinite(args.standardClassPreResolvedRate)
  ) {
    return args.standardClassPreResolvedRate;
  }

  const cacheKey = `${region}::${cls}`;
  if (rateCache.has(cacheKey)) {
    return rateCache.get(cacheKey)!;
  }
  if (unavailableCache.has(cacheKey)) {
    return null;
  }

  const usagetype = S3_CLASS_TO_USAGETYPE[cls];
  // Filters mirror the S3 decomposer's storage line item, with the
  // class-specific `usagetype` swapped in. ProductFamily stays
  // `Storage` for every class today — the Pricing API does NOT split
  // Glacier into a separate `Cold Storage` family, despite some older
  // AWS docs implying otherwise (verified against real us-east-1
  // responses 2026-05-25: Glacier storage entries carry
  // `productFamily: "Storage"`).
  const filters: McpPricingFilter[] = [
    {
      Field: PricingField.PRODUCT_FAMILY,
      Value: PricingProductFamily.STORAGE,
      Type: PricingMatchType.TERM_MATCH,
    },
    {
      Field: PricingField.USAGE_TYPE,
      Value: usagetype,
      Type: PricingMatchType.TERM_MATCH,
    },
  ];
  try {
    const rawResult = await withRetry(() =>
      withTimeout(
        pricingTool.invoke({
          service_code: PricingServiceCode.S3,
          region,
          filters,
          output_options: {
            pricing_terms: [PricingTerm.ON_DEMAND],
          },
        }),
        PRICING_MCP_TIMEOUT_MS,
      ),
    );
    if (rawResult === null) {
      unavailableCache.add(cacheKey);
      return null;
    }
    const data = JSON.parse(
      unwrapPricingMcpText(rawResult),
    ) as AwsPricingResponse;
    const priceStr = extractFirstTierPrice(
      data,
      PriceUnit.PER_GB_MONTH,
      1,
      filters,
    );
    if (!priceStr) {
      unavailableCache.add(cacheKey);
      return null;
    }
    const numericPart = priceStr.replace(/^\$/, "").replace(/\/.*$/, "");
    const rate = parseFloat(numericPart);
    if (!Number.isFinite(rate)) {
      unavailableCache.add(cacheKey);
      return null;
    }
    rateCache.set(cacheKey, rate);
    return rate;
  } catch {
    unavailableCache.add(cacheKey);
    return null;
  }
}

/**
 * Prefix a `$X.XX/mo` money-shaped label with the unicode `≈` to flag
 * that the total is an estimate (Glacier sub-tier ambiguity). Leaves
 * non-money-shaped labels (rate hints, `unavailable`, `$0/mo`)
 * untouched.
 */
function prefixApproxIfMoneyLabel(label: string): string {
  if (/^\$\d+(\.\d+)?\/mo$/.test(label)) {
    return `≈${label}`;
  }
  return label;
}

/**
 * Compute the cumulative cost of `gb` GB of CloudFront data transfer
 * across a tiered rate ladder. Mirrors AWS's monthly billing model:
 * the first N GB charge at tier 1's rate, the next M GB at tier 2's
 * rate, and so on. Tiers with `endRange === undefined` are the
 * top-tier (infinity).
 *
 * Returns `null` when the tier ladder is empty or non-monotonic
 * (caller falls back to rate-hint display).
 *
 * Worked example for 1 TB (1000 GB) with the canonical CloudFront
 * North America rate card:
 *   Tier 1 (0–10 TB):  1000 GB × $0.085 = $85.00
 * The whole TB stays in tier 1; no tier 2 contribution. For 15 TB:
 *   Tier 1 (0–10 TB):  10240 GB × $0.085 = $870.40
 *   Tier 2 (10–50 TB): (15360-10240) GB × $0.080 = $409.60
 *   Total: $1,280.00
 *
 * Exported `internal` for unit tests in `pricing-enricher.test.ts`.
 */
export function computeTieredCost(
  gb: number,
  tiers: PriceTier[],
): number | null {
  if (!tiers || tiers.length === 0) return null;
  if (gb <= 0) return 0;
  let total = 0;
  let remaining = gb;
  for (const tier of tiers) {
    if (remaining <= 0) break;
    const tierStart = tier.beginRange;
    const tierEnd = tier.endRange ?? Infinity;
    const tierWidth = tierEnd - tierStart;
    if (tierWidth <= 0) continue;
    const rate = parseFloat(tier.rate);
    if (!Number.isFinite(rate)) return null;
    const consume = Math.min(remaining, tierWidth);
    total += consume * rate;
    remaining -= consume;
  }
  return total;
}

/**
 * Per-distribution CloudFront F6 promotion. Pulls the data-transfer
 * tier ladder + the per-request rate via two Pricing MCP calls (one
 * per usage-based line item the decomposer emits), then for each
 * distribution in the group:
 *   - Reads `cloudfrontRequestsPerMonth` + `cloudfrontBytesPerMonth`
 *     from the usage map (populated by the CloudWatch usage-enricher).
 *   - Computes `(requests × perRequestRate) + tieredCost(bytes)`.
 *   - Promotes to `$X.XX/mo` via `formatCostLabel`.
 *   - Falls back to a rate-hint display (the per-GB ladder summary)
 *     when usage data is missing or fields are exactly 0 (the
 *     CloudWatch enricher's "no traffic observed" signal — which is
 *     distinct from "no data": a zero multiplier would yield a
 *     misleading $0.00/mo so we surface the rate hint instead).
 *
 * Errors thrown by the inner MCP calls are caught at the per-tuple
 * level — every distribution in the group falls back to the rate-hint
 * branch (or N/A if even the rate-hint can't be extracted). This
 * preserves the conservative-keep contract: the enricher never
 * regresses the pre-F6 display.
 */
async function enrichCloudFrontGroup(args: {
  group: ManagedResource[];
  effectiveRegion: string;
  pricingTool: StructuredTool;
  usageByArn: Map<string, ResourceUsage>;
  result: Map<string, string>;
}): Promise<void> {
  const { group, effectiveRegion, pricingTool, usageByArn, result } = args;

  // F6-ITEM-2 baseline: North-America-edge baseline ($0.085/GB tier 1)
  // — deterministic across runs thanks to the
  // `fromLocation = "North America"` filter pinned in the CloudFront
  // decomposer. Limitation: distributions deployed with
  // `PriceClass_All` that route significant traffic through SG / HK /
  // JP edges ($0.110–0.120/GB) under-cost by up to ~41%.
  // PriceClass-aware enrichment requires extra
  // `cloudfront:GetDistributionConfig` calls + per-edge-region rate
  // selection — tracked as F6-followup.
  const desiredState = buildMinimalDesiredState(
    RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION,
  );
  const lineItems = defaultDecomposerRegistry.decompose(
    RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION,
    desiredState,
  );
  // Decomposer contract: [0] = Data transfer out, [1] = Requests.
  const dataTransferItem = lineItems[0];
  const requestsItem = lineItems[1];
  if (!dataTransferItem || !requestsItem) {
    // Decomposer reshuffled — degrade to no entries for the group
    // (consumer leaves rows as N/A).
    return;
  }

  // Pull the tiered data-transfer ladder.
  let tiers: PriceTier[] | undefined;
  let dataTransferRateHint: string | undefined;
  try {
    const rawResult = await withRetry(() =>
      withTimeout(
        pricingTool.invoke({
          service_code: dataTransferItem.serviceCode,
          region: effectiveRegion,
          filters: dataTransferItem.filters,
          output_options: {
            pricing_terms: [PricingTerm.ON_DEMAND],
          },
        }),
        PRICING_MCP_TIMEOUT_MS,
      ),
    );
    if (rawResult !== null) {
      const data = JSON.parse(
        unwrapPricingMcpText(rawResult),
      ) as AwsPricingResponse;
      const tiered = extractTieredPrice(data, dataTransferItem.filters);
      if (tiered) {
        tiers = tiered.tiers;
        dataTransferRateHint = tiered.text;
      } else {
        // Non-tiered response (some regions surface a flat per-GB
        // rate) — fall back to extractFirstTierPrice so we still
        // have at least the headline rate string.
        const flat = extractFirstTierPrice(
          data,
          dataTransferItem.priceUnit,
          dataTransferItem.scale,
          dataTransferItem.filters,
        );
        if (flat) {
          dataTransferRateHint = flat;
          const rate = parseFloat(flat.replace(/^\$/, "").replace(/\/.*$/, ""));
          if (Number.isFinite(rate)) {
            tiers = [
              {
                beginRange: 0,
                rate: String(rate),
                currency: "USD",
                unit: "GB",
              },
            ];
          }
        }
      }
    }
  } catch {
    // Inner MCP call failed — fall through; perRequestRate may still
    // resolve and the per-distribution branch will gracefully degrade.
  }

  // Pull the per-request rate (flat tier).
  let perRequestRate: number | undefined;
  let requestsRateHint: string | undefined;
  try {
    const rawResult = await withRetry(() =>
      withTimeout(
        pricingTool.invoke({
          service_code: requestsItem.serviceCode,
          region: effectiveRegion,
          filters: requestsItem.filters,
          output_options: {
            pricing_terms: [PricingTerm.ON_DEMAND],
          },
        }),
        PRICING_MCP_TIMEOUT_MS,
      ),
    );
    if (rawResult !== null) {
      const data = JSON.parse(
        unwrapPricingMcpText(rawResult),
      ) as AwsPricingResponse;
      const flat = extractFirstTierPrice(
        data,
        requestsItem.priceUnit,
        requestsItem.scale,
        requestsItem.filters,
      );
      if (flat) {
        requestsRateHint = flat;
        // Invariant: CloudFront requests are per-request; rate × raw
        // count = monthly cost.
        const rate = parseFloat(flat.replace(/^\$/, "").replace(/\/.*$/, ""));
        if (Number.isFinite(rate)) {
          perRequestRate = rate;
        }
      }
    }
  } catch {
    // ditto — fall through; per-distribution branch handles missing rate.
  }

  // Per-distribution label assignment.
  for (const r of group) {
    if (!r.arn) continue;
    const usage = usageByArn.get(r.arn);
    const requests = usage?.cloudfrontRequestsPerMonth;
    const bytesGb = usage?.cloudfrontBytesPerMonth;

    // Promotion path: BOTH usage dimensions must be populated AND
    // strictly positive. A zero on either side means the CloudWatch
    // enricher saw the distribution but observed no traffic — the
    // pricing math would yield a misleading $0.00/mo, so we surface
    // the rate-hint fallback instead. ("Zero is not no-data; zero is
    // a meaningful 'idle' signal that the rate-hint display
    // communicates more accurately than a fake total.")
    const canPromote =
      requests !== undefined &&
      requests > 0 &&
      bytesGb !== undefined &&
      bytesGb > 0 &&
      perRequestRate !== undefined &&
      tiers !== undefined &&
      tiers.length > 0;

    if (canPromote) {
      const dataTransferCost = computeTieredCost(bytesGb!, tiers!);
      if (dataTransferCost !== null) {
        const requestsCost = requests! * perRequestRate!;
        const total = dataTransferCost + requestsCost;
        result.set(r.arn, `$${total.toFixed(2)}/mo`);
        continue;
      }
    }

    // Fallback: rate-hint display. Prefer the tier-ladder text from
    // extractTieredPrice (richest signal); fall back to the
    // first-tier hint string; finally to a generic "$rate/GB"
    // synthesised string if neither parse succeeded. Skip the row
    // entirely if we have NOTHING (consumer leaves it as N/A).
    const hint = dataTransferRateHint ?? requestsRateHint;
    if (hint) {
      result.set(r.arn, hint);
    }
  }
}
