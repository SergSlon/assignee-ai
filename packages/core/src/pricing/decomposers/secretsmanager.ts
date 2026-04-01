/**
 * Secrets Manager Pricing Decomposer — breaks a secret into billable components:
 * secret storage (fixed per secret) and API calls (usage-based).
 *
 * @see Story 23.3
 */

import { RESOURCE_TYPES } from "../../config/resource-types.js";
import type {
  PricingDecomposer,
  PricingLineItem,
} from "../decomposer-types.js";

export const secretsManagerPricingDecomposer: PricingDecomposer = {
  resourceType: RESOURCE_TYPES.SECRETSMANAGER_SECRET,

  decompose(_desiredState: Record<string, unknown>): PricingLineItem[] {
    const items: PricingLineItem[] = [];

    // 1. Secret storage
    items.push({
      label: "Secret storage",
      quantity: 1,
      unit: "secret",
      serviceCode: "AWSSecretsManager",
      filters: [
        { Field: "productFamily", Value: "Secret", Type: "TERM_MATCH" },
      ],
      kind: "fixed",
      description: "1 secret",
      priceUnit: "/secret-mo",
    });

    // 2. API calls
    items.push({
      label: "API calls",
      quantity: 0,
      unit: "requests",
      serviceCode: "AWSSecretsManager",
      filters: [
        { Field: "productFamily", Value: "API Request", Type: "TERM_MATCH" },
      ],
      kind: "usage_based",
      description: "per 10,000 API calls",
      priceUnit: "/10K reqs",
    });

    return items;
  },
};
