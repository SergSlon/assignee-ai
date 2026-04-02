/**
 * Lambda Pricing Decomposer — breaks a Lambda function into billable components:
 * requests per million, duration (GB-seconds), and CloudWatch Logs.
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

export const lambdaPricingDecomposer: PricingDecomposer = {
  resourceType: RESOURCE_TYPES.LAMBDA_FUNCTION,

  decompose(desiredState: Record<string, unknown>): PricingLineItem[] {
    const items: PricingLineItem[] = [];
    const memoryMb = Number(desiredState[CfnKey.MEMORY_SIZE] ?? 128);

    // 1. Requests (per million) — use usagetype=Request to find request pricing
    items.push({
      label: LineItemLabel.REQUESTS,
      quantity: 0,
      unit: PricingUnit.REQUESTS,
      serviceCode: SC.LAMBDA,
      filters: [
        { Field: F.PRODUCT_FAMILY, Value: PF.SERVERLESS, Type: M.TERM_MATCH },
        { Field: F.USAGE_TYPE, Value: FV.LAMBDA_REQUEST, Type: M.TERM_MATCH },
      ],
      kind: K.USAGE_BASED,
      description: DecomposerDescription.PER_MILLION,
      priceUnit: PriceUnit.PER_MILLION_REQS,
      scale: 1_000_000,
    });

    // 2. Duration (GB-seconds) — use usagetype=Lambda-GB-Second
    items.push({
      label: LineItemLabel.DURATION,
      quantity: 0,
      unit: PricingUnit.GB_SECOND,
      serviceCode: SC.LAMBDA,
      filters: [
        { Field: F.PRODUCT_FAMILY, Value: PF.SERVERLESS, Type: M.TERM_MATCH },
        { Field: F.USAGE_TYPE, Value: FV.LAMBDA_GB_SECOND, Type: M.TERM_MATCH },
      ],
      kind: K.USAGE_BASED,
      description: `${memoryMb} MB, 100ms avg`,
      priceUnit: PriceUnit.PER_GB_SECOND,
    });

    // 3. CloudWatch Logs (usage-based) — use usagetype for log ingestion
    items.push({
      label: LineItemLabel.CLOUDWATCH_LOGS,
      quantity: 0,
      unit: PricingUnit.GB,
      serviceCode: SC.CLOUDWATCH,
      filters: [
        { Field: F.PRODUCT_FAMILY, Value: PF.DATA_PAYLOAD, Type: M.TERM_MATCH },
        {
          Field: F.USAGE_TYPE,
          Value: FV.DATA_PROCESSING_BYTES,
          Type: M.TERM_MATCH,
        },
      ],
      kind: K.USAGE_BASED,
      description: "ingested",
      priceUnit: PriceUnit.PER_GB_INGESTED,
    });

    return items;
  },
};
