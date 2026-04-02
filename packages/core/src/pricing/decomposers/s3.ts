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

export const s3PricingDecomposer: PricingDecomposer = {
  resourceType: RESOURCE_TYPES.S3_BUCKET,

  decompose(_desiredState: Record<string, unknown>): PricingLineItem[] {
    const items: PricingLineItem[] = [];

    // 1. Storage (per GB-month)
    items.push({
      label: "Storage",
      quantity: 0,
      unit: "GB",
      serviceCode: SC.S3,
      filters: [
        { Field: F.PRODUCT_FAMILY, Value: PF.STORAGE, Type: M.TERM_MATCH },
        {
          Field: F.USAGE_TYPE,
          Value: "TimedStorage-ByteHrs",
          Type: M.TERM_MATCH,
        },
      ],
      kind: K.USAGE_BASED,
      description: "Standard",
      priceUnit: "/GB-mo",
    });

    // 2. PUT requests
    items.push({
      label: "PUT requests",
      quantity: 0,
      unit: "requests",
      serviceCode: SC.S3,
      filters: [
        { Field: F.PRODUCT_FAMILY, Value: PF.API_REQUEST, Type: M.TERM_MATCH },
        { Field: F.USAGE_TYPE, Value: "Requests-Tier1", Type: M.TERM_MATCH },
      ],
      kind: K.USAGE_BASED,
      description: "per 1,000 requests",
      priceUnit: "/1000 reqs",
    });

    // 3. GET requests
    items.push({
      label: "GET requests",
      quantity: 0,
      unit: "requests",
      serviceCode: SC.S3,
      filters: [
        { Field: F.PRODUCT_FAMILY, Value: PF.API_REQUEST, Type: M.TERM_MATCH },
        { Field: F.USAGE_TYPE, Value: "Requests-Tier2", Type: M.TERM_MATCH },
      ],
      kind: K.USAGE_BASED,
      description: "per 1,000 requests",
      priceUnit: "/1000 reqs",
    });

    // 4. Data transfer out
    items.push({
      label: "Data transfer out",
      quantity: 0,
      unit: "GB",
      serviceCode: SC.DATA_TRANSFER,
      filters: [
        {
          Field: F.PRODUCT_FAMILY,
          Value: PF.DATA_TRANSFER,
          Type: M.TERM_MATCH,
        },
        {
          Field: F.FROM_LOCATION_TYPE,
          Value: "AWS Region",
          Type: M.TERM_MATCH,
        },
        { Field: F.TO_LOCATION_TYPE, Value: "External", Type: M.TERM_MATCH },
        { Field: F.TRANSFER_TYPE, Value: "AWS Outbound", Type: M.TERM_MATCH },
      ],
      kind: K.USAGE_BASED,
      description: "per GB",
      priceUnit: "/GB",
    });

    return items;
  },
};
