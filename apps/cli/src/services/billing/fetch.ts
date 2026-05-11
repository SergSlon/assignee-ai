/**
 * Top-level billing-data fetch with graceful-degradation chain:
 *   1. Billing MCP (live)
 *   2. Provision-log memory (historical estimates)
 *   3. Empty map (cost shows "N/A")
 *
 * Extracted from billing.ts during Wave-6c decomposition.
 *
 * @see Story 19.7
 * @see Story 46.2 — provenance tag
 * @see Epic 92 Wave 4 (e92.4.a) — savings formatter sanitation
 */

import type { StructuredTool } from "@langchain/core/tools";
import { CostEstimateLabel, createListPricingEnricher } from "@assignee/core";
import { AWS_REGION, UNKNOWN_FALLBACK } from "../../config/constants.js";
import type { ManagedResource } from "../list-resources.js";
import { defaultMemoryService } from "../memory.js";
import { queryBillingMcp } from "./cost-explorer.js";
import { logBillingMcpFailure } from "./error-handler.js";
import type { BillingCostData } from "./types.js";

/**
 * Epic 92 Wave 4 (e92.4.a) — display-only zero tokens for free / unavailable
 * savings lines. These are NOT price lookups: `FREE_SAVINGS_DISPLAY` renders
 * a zero-sentinel for resources the pricing layer has already marked as
 * `CostEstimateLabel.FREE` / `CostEstimateLabel.NO_CHARGE`, and
 * `NO_SAVINGS_DISPLAY` is the noun-phrase used when the MCP returned no
 * parseable dollar amount. Zero hardcoded prices — the `$0.00` literal
 * below is a display string, never a rate lookup.
 */
const FREE_SAVINGS_DISPLAY = "Free, $0.00 savings" as const;
const NO_SAVINGS_DISPLAY = "No cost savings" as const;

/**
 * Heuristic: does this string look like a parseable dollar amount?
 *
 * Covers the happy-path MCP formats:
 *   - `$0.02/month`
 *   - `$3.00/mo`
 *   - `~$32.85/mo`
 *   - `$99.99/mo`
 *
 * Rejects non-numeric labels:
 *   - `"Free"`, `"No charge"`, `"N/A"`
 *   - `"Per-request pricing (standard queue)"`
 *   - `"Per-request pricing (FIFO queue)"`
 *   - `"Per-GB pricing"`
 */
function isParseableDollarAmount(s: string): boolean {
  return /\$\d/.test(s);
}

/**
 * Unifies the per-month cost label so the destroy-savings line matches the
 * `$X.XX/mo` shape that `assignee list` shows in `pricing-enricher.ts`.
 *
 * Inputs (any of these) → `$X.XX/mo`:
 *   - `$1.0000/key-month` (mcp-parser.ts emits 4-decimal `key-month` for
 *     scaled amounts ≥ 0.0001 — replayed verbatim from provision-log
 *     `estimatedMonthlyCost` strings via `getCostSavingsEstimate` →
 *     `formatSavingsDisplay`)
 *   - `$1.00/key-mo`
 *   - `$1.00/month`
 *   - `$1.00/mo` (already canonical, only re-quantizes the decimal)
 *
 * Anything else (e.g. `$0.0230/GB-Mo`, `$0.0001/hr`, prefixed `~$32.85/mo`,
 * non-dollar labels) is returned unchanged so the caller's existing branches
 * (Free / No-charge / N/A) keep working.
 */
function normalizeMonthlyCostLabel(s: string): string {
  const m = s.match(/^\$(\d+(?:\.\d+)?)\/(?:key-mo(?:nth)?|month|mo)$/);
  if (!m) return s;
  return `$${parseFloat(m[1]!).toFixed(2)}/mo`;
}

/**
 * Epic 92 Wave 4 (e92.4.a) — render the savings suffix safely.
 * Closes A-08 / B-21 / D-15 / D-18.
 *
 * Three buckets:
 *   1. Parseable dollar amount (matches `$N`)    → `"{cost} saved"`.
 *   2. Free / No charge (pricing-layer sentinels) → `"Free, $0.00 savings"`.
 *   3. Anything else (N/A, per-request pricing…)  → `"No cost savings"`.
 *
 * Exported for direct testing; also consumed by the destroy-side
 * formatter in `apps/cli/src/commands/destroy/result-formatter.ts`
 * (which receives the already-formatted string via
 * `getCostSavingsEstimate`).
 */
export function formatSavingsDisplay(actualMonthlyCost: string): string {
  // Normalize KMS-style `$1.0000/key-month` and other per-month variants
  // to the canonical `$1.00/mo` so the destroy savings line matches the
  // `assignee list` cost column. Non-monthly units (e.g. `/GB-Mo`, `/hr`)
  // pass through unchanged. Sentinel buckets (Free / No-charge) also
  // pass through because the regex demands a leading `$` + digit.
  const unified = normalizeMonthlyCostLabel(actualMonthlyCost);
  if (isParseableDollarAmount(unified)) {
    return `${unified} saved`;
  }
  if (
    unified === CostEstimateLabel.FREE ||
    unified === CostEstimateLabel.NO_CHARGE
  ) {
    return FREE_SAVINGS_DISPLAY;
  }
  return NO_SAVINGS_DISPLAY;
}

/**
 * Fetches live billing data for managed resources from the Billing MCP server.
 * Falls back to provision log memory if MCP is unavailable.
 */
export async function fetchBillingData(
  resources: ManagedResource[],
  mcpTools?: StructuredTool[],
): Promise<Map<string, BillingCostData>> {
  const costMap = new Map<string, BillingCostData>();

  // Try Billing MCP server first
  if (mcpTools && mcpTools.length > 0) {
    try {
      const billingData = await queryBillingMcp(resources, mcpTools);
      for (const entry of billingData) {
        costMap.set(entry.arn, entry);
      }
      if (costMap.size > 0) return costMap;
    } catch (err) {
      // MCP unavailable — fall through to memory fallback. Log at warn so
      // operators can correlate "offline" provenance rows with the root cause.
      logBillingMcpFailure("fetchBillingData.queryBillingMcp", err);
    }
  }

  // Fallback: provision log memory
  // Story 46.2: tag every fallback row "offline" so the user can tell at a
  // glance that they're looking at log replay, not live AWS data.
  const provisions = await defaultMemoryService.readProvisions();
  for (const p of provisions) {
    if (p.resourceArn && p.estimatedMonthlyCost) {
      costMap.set(p.resourceArn, {
        arn: p.resourceArn,
        actualMonthlyCost: p.estimatedMonthlyCost,
        forecastedMonthlyCost: p.estimatedMonthlyCost,
        currency: "USD",
        lastUpdated: p.timestamp,
        source: "offline",
      });
    }
  }

  return costMap;
}

/**
 * Gets cost savings estimate for a specific resource.
 * Used by `assignee destroy` to show savings when removing a resource.
 *
 * Epic 92 Wave 4 (e92.4.a) — sanitized output:
 *   - parseable dollar amount (`$0.02/month`) → `"$0.02/mo saved"`
 *     (polish 2026-05-09: per-month variants are normalised to the
 *     canonical `$X.XX/mo` shape rendered by `assignee list`)
 *   - `CostEstimateLabel.FREE` / `CostEstimateLabel.NO_CHARGE` →
 *     `"Free, $0.00 savings"` (closes B-21 + D-18)
 *   - anything else (incl. `CostEstimateLabel.NA`,
 *     `"Per-request pricing (standard queue)"`, `"Per-GB pricing"`) →
 *     `"No cost savings"` (closes A-08 + D-15)
 *   - MCP + provision-log both empty AND no decomposer registered →
 *     `"No cost savings"`
 *
 * Defect 3 fix (2026-05-09): when the cost-explorer MCP and the
 * provision-log fallback both return nothing AND a `resourceType` is
 * known, fall back to the per-resource pricing decomposer registry
 * (the same path that powers the `$1.00/mo` rendering in
 * `assignee list` for a fresh KMS key). The destroy path used to ship
 * `UNKNOWN_FALLBACK` as the resourceType, which fed the cost-explorer
 * lookup a service it could never resolve, and then short-circuited
 * straight to "No cost savings" — even for KMS keys where the list
 * command had just shown `$1.00/mo` a moment earlier.
 *
 * The new optional `resourceType` parameter is the bridge: when callers
 * thread it through (every site in the destroy flow does), we use it
 * BOTH (a) to populate the dummy ManagedResource with the real type
 * for cost-explorer / provision-log lookups, AND (b) to drive the
 * decomposer fallback when neither lookup yields a value. Callers that
 * don't yet pass it (legacy non-destroy callsites) get the original
 * UNKNOWN_FALLBACK behaviour with no decomposer fallback.
 *
 * Zero hardcoded prices: the `$1.00/mo` value flows out of the
 * `kms-key.ts` decomposer at runtime, not a literal in this file.
 *
 * @returns Formatted string. Never throws.
 */
// T2-2: Explicit TypeScript overload signatures replace the union-type
// parameter + runtime `typeof` shim. Both call-site forms remain valid:
// - Legacy 2-arg: getCostSavingsEstimate(arn, mcpTools)
// - Modern 3-arg:  getCostSavingsEstimate(arn, resourceType, mcpTools)
// Behaviour is byte-identical to the previous union-type implementation.

/** @overload Legacy 2-arg form — resourceType defaults to UNKNOWN_FALLBACK. */
export async function getCostSavingsEstimate(
  arn: string,
  mcpTools?: StructuredTool[],
): Promise<string>;
/** @overload Modern 3-arg form — resourceType enables the decomposer fallback. */
export async function getCostSavingsEstimate(
  arn: string,
  resourceType: string,
  mcpTools?: StructuredTool[],
): Promise<string>;
/** Implementation — not visible to callers directly. */
export async function getCostSavingsEstimate(
  arn: string,
  mcpToolsOrResourceType?: StructuredTool[] | string,
  maybeMcpTools?: StructuredTool[],
): Promise<string> {
  // ── Argument resolution: backwards-compatible 2-arg form ──────────
  // Existing callers pass `(arn, mcpTools)`. New destroy-flow callers
  // pass `(arn, resourceType, mcpTools)`. Detect by type — when the
  // second arg is a string we treat it as the resourceType.
  const resourceType =
    typeof mcpToolsOrResourceType === "string"
      ? mcpToolsOrResourceType
      : undefined;
  const mcpTools = Array.isArray(mcpToolsOrResourceType)
    ? mcpToolsOrResourceType
    : maybeMcpTools;

  try {
    const dummyResource: ManagedResource = {
      resourceType: resourceType ?? UNKNOWN_FALLBACK,
      arn,
      region: AWS_REGION,
      createdDate: CostEstimateLabel.NA,
      estimatedMonthlyCost: CostEstimateLabel.NA,
    };

    const costMap = await fetchBillingData([dummyResource], mcpTools);
    const data = costMap.get(arn);
    if (data) {
      return formatSavingsDisplay(data.actualMonthlyCost);
    }

    // ── Defect 3: decomposer-registry fallback ──────────────────────
    // Cost-explorer + provision-log both empty. If we know the
    // resourceType, ask the same per-resource pricing decomposer that
    // `assignee list` uses to compute $X.XX/mo from rate-card data.
    // Skip when resourceType is unknown — we'd just spin up an MCP
    // client to query a service we can't name.
    if (resourceType && resourceType !== UNKNOWN_FALLBACK) {
      const decomposerLabel = await tryDecomposerCostLabel(dummyResource);
      if (decomposerLabel) {
        return formatSavingsDisplay(decomposerLabel);
      }
    }
  } catch (err) {
    logBillingMcpFailure("getCostSavingsEstimate", err);
    // Graceful degradation
  }

  return NO_SAVINGS_DISPLAY;
}

/**
 * Defect 3 helper: invoke the canonical per-resource pricing enricher
 * (the one `assignee list` uses) for a single resource and extract the
 * resulting cost label. Returns `undefined` on any failure (no
 * decomposer, MCP unavailable, registry mismatch) so the caller can
 * fall through to the "No cost savings" sentinel.
 *
 * Reuses `createListPricingEnricher` from `@assignee/core/list-resources`
 * — the SAME function path that powers the `$1.00/mo` rendering for KMS
 * keys in `assignee list`. Calling it from the destroy path keeps the
 * two surfaces in sync (no two-source-of-truth drift).
 */
async function tryDecomposerCostLabel(
  resource: ManagedResource,
): Promise<string | undefined> {
  try {
    const enricher = createListPricingEnricher();
    const labels = await enricher([resource]);
    return labels.get(resource.arn);
  } catch (err) {
    logBillingMcpFailure("getCostSavingsEstimate.decomposerFallback", err);
    return undefined;
  }
}
