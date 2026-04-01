/**
 * SNS Pricing Decomposer — breaks an SNS topic into billable components:
 * publish requests (Standard vs FIFO) and HTTP notification delivery.
 *
 * @see Story 23.3
 */

import { CfnKey } from "../../config/cfn-keys.js";
import { RESOURCE_TYPES } from "../../config/resource-types.js";
import type {
  PricingDecomposer,
  PricingLineItem,
} from "../decomposer-types.js";

export const snsPricingDecomposer: PricingDecomposer = {
  resourceType: RESOURCE_TYPES.SNS_TOPIC,

  decompose(desiredState: Record<string, unknown>): PricingLineItem[] {
    const items: PricingLineItem[] = [];
    const topicName = String(desiredState[CfnKey.TOPIC_NAME] ?? "");
    const fifoFlag = desiredState[CfnKey.FIFO_TOPIC];
    const isFifo =
      fifoFlag === true || fifoFlag === "true" || topicName.endsWith(".fifo");

    // 1. Publishes
    items.push({
      label: "Publishes",
      quantity: 0,
      unit: "requests",
      serviceCode: "AmazonSNS",
      filters: [
        {
          Field: "productFamily",
          Value: "Message Delivery",
          Type: "TERM_MATCH",
        },
      ],
      kind: "usage_based",
      description: isFifo ? "FIFO topic" : "Standard topic",
      priceUnit: "/M publishes",
      scale: 1_000_000,
    });

    // 2. HTTP notifications
    items.push({
      label: "HTTP notifications",
      quantity: 0,
      unit: "notifications",
      serviceCode: "AmazonSNS",
      filters: [
        {
          Field: "productFamily",
          Value: "Message Delivery",
          Type: "TERM_MATCH",
        },
        {
          Field: "usagetype",
          Value: "DeliveryAttempts-HTTP",
          Type: "TERM_MATCH",
        },
      ],
      kind: "usage_based",
      description: "per 100K",
      priceUnit: "/100K notifs",
    });

    return items;
  },
};
