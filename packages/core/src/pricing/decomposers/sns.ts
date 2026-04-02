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
import {
  PricingField as F,
  PricingKind as K,
  PricingMatchType as M,
  PricingProductFamily as PF,
  PricingServiceCode as SC,
} from "../filter-constants.js";

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
      serviceCode: SC.SNS,
      filters: [
        {
          Field: F.PRODUCT_FAMILY,
          Value: PF.MESSAGE_DELIVERY,
          Type: M.TERM_MATCH,
        },
      ],
      kind: K.USAGE_BASED,
      description: isFifo ? "FIFO topic" : "Standard topic",
      priceUnit: "/M publishes",
      scale: 1_000_000,
    });

    // 2. HTTP notifications
    items.push({
      label: "HTTP notifications",
      quantity: 0,
      unit: "notifications",
      serviceCode: SC.SNS,
      filters: [
        {
          Field: F.PRODUCT_FAMILY,
          Value: PF.MESSAGE_DELIVERY,
          Type: M.TERM_MATCH,
        },
        {
          Field: F.USAGE_TYPE,
          Value: "DeliveryAttempts-HTTP",
          Type: M.TERM_MATCH,
        },
      ],
      kind: K.USAGE_BASED,
      description: "per 100K",
      priceUnit: "/100K notifs",
    });

    return items;
  },
};
