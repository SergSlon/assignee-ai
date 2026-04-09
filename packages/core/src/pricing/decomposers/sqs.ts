/**
 * SQS Pricing Decomposer — breaks an SQS queue into billable components.
 *
 *   1. Requests — per-million, rate depends on Standard vs FIFO.
 *   2. Data transfer out to the public internet — usage-based. Only
 *      applies when consumers pull messages from outside the queue's
 *      region (cross-region + cross-AZ-sometimes). Volume is
 *      workload-dependent and not knowable from desiredState, so the
 *      line item is emitted with quantity=0 and the advisor surfaces
 *      it as a "watch this if your consumers are in another region"
 *      reminder.
 *
 * @see Story 23.3 — original single-line-item decomposer
 * @see (f) 2026-04-09 — added the DTO line so SQS has the same
 *      plan-box shape as other request-based services (SNS Topic,
 *      API Gateway, DynamoDB).
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

    // 1. Requests (per-million, rate depends on FIFO vs Standard).
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

    // 2. Data transfer out. SQS data transfer out of AWS to the
    //    public internet is billed at the standard EC2 rate (~$0.09/GB
    //    tiered). In-region traffic between EC2/Lambda/ECS consumers
    //    and the queue is FREE and should not be counted here.
    //    The cost-advisor annotates this line with a "only fires if
    //    consumers are outside the queue's region" reminder at plan
    //    time, because in-region consumption is the overwhelming
    //    common case and charging for it would be wrong.
    items.push({
      label: LineItemLabel.DATA_TRANSFER_OUT,
      quantity: 0,
      unit: PricingUnit.GB,
      serviceCode: SC.SQS,
      filters: [
        {
          Field: F.PRODUCT_FAMILY,
          Value: PF.DATA_TRANSFER,
          Type: M.TERM_MATCH,
        },
      ],
      kind: K.USAGE_BASED,
      description: "Data transfer out (only cross-region consumers)",
      priceUnit: PriceUnit.PER_GB,
    });

    return items;
  },
};
