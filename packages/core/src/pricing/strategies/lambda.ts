import type { PricingStrategy, PricingEstimate } from "../types.js";
import { LAMBDA_USD_PER_GB_SECOND } from "../../resource-plugins/plugins/lambda-function.js";
import { CfnKey } from "../../config/cfn-keys.js";

// Lambda pricing rates (stable since 2014 — verified 2025)
const USD_PER_MILLION_REQUESTS = 0.2;
const ASSUMED_AVG_DURATION_SEC = 0.1;
const DEFAULT_MEMORY_MB = 128;

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
    return { perMonth: null, label: computeLambdaLabel(memoryMb) };
  },
  // No mcpConfig — Lambda pricing is computed locally from MemorySize
};
