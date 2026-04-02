/**
 * S3 Pricing Decomposer — breaks an S3 bucket into billable components:
 * storage rate, PUT/GET requests, and data transfer.
 *
 * @see Story 23.3
 */

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
import { PricingFilterValue as FV } from "../pricing-filter-values.js";
import { PricingUnit } from "../units.js";

export const s3PricingDecomposer: PricingDecomposer = {
  resourceType: RESOURCE_TYPES.S3_BUCKET,

  decompose(_desiredState: Record<string, unknown>): PricingLineItem[] {
    const items: PricingLineItem[] = [];

    // 1. Storage (per GB-month)
    items.push({
      label: LineItemLabel.STORAGE,
      quantity: 0,
      unit: PricingUnit.GB,
      serviceCode: SC.S3,
      filters: [
        { Field: F.PRODUCT_FAMILY, Value: PF.STORAGE, Type: M.TERM_MATCH },
        {
          Field: F.USAGE_TYPE,
          Value: FV.TIMED_STORAGE_BYTE_HRS,
          Type: M.TERM_MATCH,
        },
      ],
      kind: K.USAGE_BASED,
      description: "Standard",
      priceUnit: PriceUnit.PER_GB_MONTH,
    });

    // 2. PUT requests
    items.push({
      label: LineItemLabel.PUT_REQUESTS,
      quantity: 0,
      unit: PricingUnit.REQUESTS,
      serviceCode: SC.S3,
      filters: [
        { Field: F.PRODUCT_FAMILY, Value: PF.API_REQUEST, Type: M.TERM_MATCH },
        { Field: F.USAGE_TYPE, Value: FV.REQUESTS_TIER1, Type: M.TERM_MATCH },
      ],
      kind: K.USAGE_BASED,
      description: "per 1,000 requests",
      priceUnit: PriceUnit.PER_1000_REQS,
    });

    // 3. GET requests
    items.push({
      label: LineItemLabel.GET_REQUESTS,
      quantity: 0,
      unit: PricingUnit.REQUESTS,
      serviceCode: SC.S3,
      filters: [
        { Field: F.PRODUCT_FAMILY, Value: PF.API_REQUEST, Type: M.TERM_MATCH },
        { Field: F.USAGE_TYPE, Value: FV.REQUESTS_TIER2, Type: M.TERM_MATCH },
      ],
      kind: K.USAGE_BASED,
      description: "per 1,000 requests",
      priceUnit: PriceUnit.PER_1000_REQS,
    });

    // 4. Data transfer out
    items.push({
      label: LineItemLabel.DATA_TRANSFER_OUT,
      quantity: 0,
      unit: PricingUnit.GB,
      serviceCode: SC.DATA_TRANSFER,
      filters: [
        {
          Field: F.PRODUCT_FAMILY,
          Value: PF.DATA_TRANSFER,
          Type: M.TERM_MATCH,
        },
        {
          Field: F.FROM_LOCATION_TYPE,
          Value: FV.AWS_REGION,
          Type: M.TERM_MATCH,
        },
        { Field: F.TO_LOCATION_TYPE, Value: FV.EXTERNAL, Type: M.TERM_MATCH },
        { Field: F.TRANSFER_TYPE, Value: FV.AWS_OUTBOUND, Type: M.TERM_MATCH },
      ],
      kind: K.USAGE_BASED,
      description: "per GB",
      priceUnit: PriceUnit.PER_GB,
    });

    return items;
  },
};
