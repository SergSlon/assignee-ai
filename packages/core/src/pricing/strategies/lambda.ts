import type { PricingStrategy, PricingEstimate } from "../types.js";
import { CfnKey } from "../../config/cfn-keys.js";

// Lambda pricing rates (stable since 2014 — verified 2025)
const USD_PER_MILLION_REQUESTS = 0.2;
const ASSUMED_AVG_DURATION_SEC = 0.1;
const DEFAULT_MEMORY_MB = 128;

/**
 * Lambda duration pricing fallback rate ($/GB-second).
 *
 * Fallback-only: used when the Pricing MCP is unavailable. The Pricing MCP
 * remains the primary source for all runtime pricing. This rate has been
 * stable since 2014 — keeping it local to the pricing strategy keeps the
 * plugin layer free of pricing data (see `feedback_no_hardcoded_prices`).
 */
const LAMBDA_USD_PER_GB_SECOND = 0.0000166667;

function computeLambdaLabel(memoryMb: number): string {
  const durationCostPerMillion =
    1_000_000 *
    ASSUMED_AVG_DURATION_SEC *
    (memoryMb / 1024) *
    LAMBDA_USD_PER_GB_SECOND;
  const total = USD_PER_MILLION_REQUESTS + durationCostPerMillion;
  return `~$${total.toFixed(2)}/million req (${ASSUMED_AVG_DURATION_SEC * 1000}ms avg, ${memoryMb}MB)`;
}

export const lambdaPricingStrategy: PricingStrategy = {
  estimateLocal(desiredState?: Record<string, unknown>): PricingEstimate {
    const memoryMb =
      typeof desiredState?.[CfnKey.MEMORY_SIZE] === "number"
        ? (desiredState[CfnKey.MEMORY_SIZE] as number)
        : DEFAULT_MEMORY_MB;
    return {
      perMonth: null,
      label: computeLambdaLabel(memoryMb),
      source: "fallback",
    };
  },
  // No mcpConfig — Lambda pricing is computed locally from MemorySize
};
