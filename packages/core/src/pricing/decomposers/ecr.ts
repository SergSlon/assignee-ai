/**
 * ECR Pricing Decomposer — breaks an ECR repository into billable components:
 * image storage.
 */

import { RESOURCE_TYPES } from "../../config/resource-types.js";
import type {
  PricingDecomposer,
  PricingLineItem,
} from "../decomposer-types.js";

export const ecrPricingDecomposer: PricingDecomposer = {
  resourceType: RESOURCE_TYPES.ECR_REPOSITORY,

  decompose(_desiredState: Record<string, unknown>): PricingLineItem[] {
    const items: PricingLineItem[] = [];

    // 1. Storage (per GB-month)
    items.push({
      label: "Storage",
      quantity: 0,
      unit: "GB",
      serviceCode: "AmazonECR",
      filters: [
        {
          Field: "productFamily",
          Value: "EC2 Container Registry",
          Type: "TERM_MATCH",
        },
      ],
      kind: "usage_based",
      description: "image storage",
      priceUnit: "/GB-mo",
    });

    return items;
  },
};
