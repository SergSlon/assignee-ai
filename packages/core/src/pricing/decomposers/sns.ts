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
import { PricingFilterValue as FV } from "../pricing-filter-values.js";
import { PriceUnit } from "../price-units.js";
import { LineItemLabel, DecomposerDescription } from "../line-item-labels.js";
import { PricingUnit } from "../units.js";

export const snsPricingDecomposer: PricingDecomposer = {
  resourceType: RESOURCE_TYPES.SNS_TOPIC,

  decompose(desiredState: Record<string, unknown>): PricingLineItem[] {
    const items: PricingLineItem[] = [];
    const topicName = String(desiredState[CfnKey.TOPIC_NAME] ?? "");
    const fifoFlag = desiredState[CfnKey.FIFO_TOPIC];
    const isFifo =
      fifoFlag === true || fifoFlag === "true" || topicName.endsWith(".fifo");

    // 1. Publishes
    //
    // EPIC-106-SNS fix: the original filter used productFamily=Message Delivery,
    // which does NOT match the actual AWS Pricing API response for publish
    // requests. The real API returns productFamily="API Request" with
    // group="SNS-Requests-Tier1" and a region-prefixed usagetype such as
    // "USE1-Requests-Tier1". Filtering on productFamily=Message Delivery
    // returned zero results and rendered "unavailable". The `group` attribute
    // is stable across all regions — same pattern as the EPIC-106-8 S3
    // PUT/GET fix that switched from region-prefixed usagetype to
    // group=S3-API-Tier1/Tier2.
    items.push({
      label: LineItemLabel.PUBLISHES,
      quantity: 0,
      unit: PricingUnit.REQUESTS,
      serviceCode: SC.SNS,
      filters: [
        { Field: F.PRODUCT_FAMILY, Value: PF.API_REQUEST, Type: M.TERM_MATCH },
        { Field: F.GROUP, Value: FV.SNS_REQUESTS_TIER1, Type: M.TERM_MATCH },
      ],
      kind: K.USAGE_BASED,
      description: isFifo ? "FIFO topic" : "Standard topic",
      priceUnit: PriceUnit.PER_MILLION_PUBLISHES,
      scale: 1_000_000,
    });

    // 2. HTTP notifications
    //
    // EPIC-106-SNS fix: the original filter used usagetype=DeliveryAttempts-HTTP,
    // which is the unprefixed form. The real AWS Pricing API returns a
    // region-prefixed value (e.g. "USE1-DeliveryAttempts-HTTP" in us-east-1),
    // so a TERM_MATCH on the unprefixed string yields zero results — same
    // bug class as EPIC-106-8 (S3 PUT/GET). The `group` attribute is
    // consistently "SNS-HTTP" across all regions and is the correct stable
    // discriminator. productFamily=Message Delivery is retained as it is
    // already the correct product family for delivery-attempt line items.
    items.push({
      label: LineItemLabel.HTTP_NOTIFICATIONS,
      quantity: 0,
      unit: PricingUnit.NOTIFICATIONS,
      serviceCode: SC.SNS,
      filters: [
        {
          Field: F.PRODUCT_FAMILY,
          Value: PF.MESSAGE_DELIVERY,
          Type: M.TERM_MATCH,
        },
        {
          Field: F.GROUP,
          Value: FV.SNS_DELIVERY_ATTEMPTS_HTTP,
          Type: M.TERM_MATCH,
        },
      ],
      kind: K.USAGE_BASED,
      description: DecomposerDescription.PER_100K,
      priceUnit: PriceUnit.PER_100K_NOTIFS,
    });

    return items;
  },
};
