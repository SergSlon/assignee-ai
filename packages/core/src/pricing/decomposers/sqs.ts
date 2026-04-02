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
import {
  PricingField as F,
  PricingKind as K,
  PricingMatchType as M,
  PricingProductFamily as PF,
  PricingServiceCode as SC,
} from "../filter-constants.js";
import { PriceUnit } from "../price-units.js";
import { LineItemLabel } from "../line-item-labels.js";
import { PricingUnit } from "../units.js";

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
      label: LineItemLabel.REQUESTS,
      quantity: 0,
      unit: PricingUnit.REQUESTS,
      serviceCode: SC.SQS,
      filters: [
        {
          Field: F.PRODUCT_FAMILY,
          Value: isFifo ? PF.FIFO_QUEUE : PF.QUEUE,
          Type: M.TERM_MATCH,
        },
      ],
      kind: K.USAGE_BASED,
      description: isFifo ? "FIFO queue" : "Standard queue",
      priceUnit: PriceUnit.PER_MILLION_REQS,
      scale: 1_000_000,
    });

    return items;
  },
};
