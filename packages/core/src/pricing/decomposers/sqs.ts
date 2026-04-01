/**
 * SQS Pricing Decomposer — breaks an SQS queue into billable components:
 * request pricing varies by Standard vs FIFO queue type.
 *
 * @see Story 23.3
 */

import { CfnKey } from "../../config/cfn-keys.js";
import { RESOURCE_TYPES } from "../../config/resource-types.js";
import type {
  PricingDecomposer,
  PricingLineItem,
} from "../decomposer-types.js";

export const sqsPricingDecomposer: PricingDecomposer = {
  resourceType: RESOURCE_TYPES.SQS_QUEUE,

  decompose(desiredState: Record<string, unknown>): PricingLineItem[] {
    const items: PricingLineItem[] = [];
    const queueName = String(desiredState[CfnKey.QUEUE_NAME] ?? "");
    const fifoFlag = desiredState[CfnKey.FIFO_QUEUE];
    const isFifo =
      fifoFlag === true || fifoFlag === "true" || queueName.endsWith(".fifo");

    // 1. Requests
    items.push({
      label: "Requests",
      quantity: 0,
      unit: "requests",
      serviceCode: "AmazonSQS",
      filters: [
        {
          Field: "productFamily",
          Value: isFifo ? "FIFO Queue" : "Queue",
          Type: "TERM_MATCH",
        },
      ],
      kind: "usage_based",
      description: isFifo ? "FIFO queue" : "Standard queue",
      priceUnit: "/M reqs",
      scale: 1_000_000,
    });

    return items;
  },
};
