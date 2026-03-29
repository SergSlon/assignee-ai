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

export const s3PricingDecomposer: PricingDecomposer = {
  resourceType: RESOURCE_TYPES.S3_BUCKET,

  decompose(_desiredState: Record<string, unknown>): PricingLineItem[] {
    const items: PricingLineItem[] = [];

    // 1. Storage (per GB-month)
    items.push({
      label: "Storage",
      quantity: 0,
      unit: "GB",
      serviceCode: "AmazonS3",
      filters: [
        { Field: "productFamily", Value: "Storage", Type: "TERM_MATCH" },
        {
          Field: "usagetype",
          Value: "TimedStorage-ByteHrs",
          Type: "TERM_MATCH",
        },
      ],
      kind: "usage_based",
      description: "Standard",
      priceUnit: "/GB-mo",
    });

    // 2. PUT requests
    items.push({
      label: "PUT requests",
      quantity: 0,
      unit: "requests",
      serviceCode: "AmazonS3",
      filters: [
        { Field: "productFamily", Value: "API Request", Type: "TERM_MATCH" },
        { Field: "usagetype", Value: "Requests-Tier1", Type: "TERM_MATCH" },
      ],
      kind: "usage_based",
      description: "per 1,000 requests",
      priceUnit: "/1000 reqs",
    });

    // 3. GET requests
    items.push({
      label: "GET requests",
      quantity: 0,
      unit: "requests",
      serviceCode: "AmazonS3",
      filters: [
        { Field: "productFamily", Value: "API Request", Type: "TERM_MATCH" },
        { Field: "usagetype", Value: "Requests-Tier2", Type: "TERM_MATCH" },
      ],
      kind: "usage_based",
      description: "per 1,000 requests",
      priceUnit: "/1000 reqs",
    });

    // 4. Data transfer out
    items.push({
      label: "Data transfer out",
      quantity: 0,
      unit: "GB",
      serviceCode: "AWSDataTransfer",
      filters: [
        { Field: "productFamily", Value: "Data Transfer", Type: "TERM_MATCH" },
        { Field: "fromLocationType", Value: "AWS Region", Type: "TERM_MATCH" },
        { Field: "toLocationType", Value: "External", Type: "TERM_MATCH" },
        { Field: "transferType", Value: "AWS Outbound", Type: "TERM_MATCH" },
      ],
      kind: "usage_based",
      description: "per GB",
      priceUnit: "/GB",
    });

    return items;
  },
};
