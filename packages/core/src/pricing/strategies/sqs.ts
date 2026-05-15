import type {
  PricingStrategy,
  PricingEstimate,
  McpPricingConfig,
} from "../types.js";
import {
  PricingField as F,
  PricingMatchType as M,
  PricingProductFamily as PF,
  PricingServiceCode as SC,
} from "../filter-constants.js";
import { PriceUnit } from "../price-units.js";

export const sqsPricingStrategy: PricingStrategy = {
  estimateLocal(desiredState?: Record<string, unknown>): PricingEstimate {
    // Tier S #1: distinguish FIFO vs Standard in the cost label so destroy
    // summaries don't say "Per-request pricing (standard queue) saved" for
    // a FIFO queue. The CloudFormation property is `FifoQueue: true|false`;
    // FIFO queues are billed at a higher per-request rate than standard.
    const isFifo = desiredState?.["FifoQueue"] === true;
    const queueKind = isFifo ? "FIFO queue" : "standard queue";
    return {
      perMonth: null,
      label: `Per-request pricing (${queueKind})`,
      source: "fallback",
    };
  },
  mcpConfig(): McpPricingConfig {
    return {
      serviceCode: SC.SQS,
      filters: [
        { Field: F.PRODUCT_FAMILY, Value: PF.QUEUE, Type: M.TERM_MATCH },
      ],
      unit: PriceUnit.PER_MILLION_REQUESTS,
    };
  },
};
