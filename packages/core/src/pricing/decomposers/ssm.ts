/**
 * SSM Parameter Pricing Decomposer — breaks an SSM parameter into billable
 * components based on tier.
 *
 * Standard tier parameters are free. Advanced tier parameters incur storage
 * and API call charges.
 */

import { CfnKey } from "../../config/cfn-keys.js";
import { RESOURCE_TYPES } from "../../config/resource-types.js";
import type {
  PricingDecomposer,
  PricingLineItem,
} from "../decomposer-types.js";

export const ssmPricingDecomposer: PricingDecomposer = {
  resourceType: RESOURCE_TYPES.SSM_PARAMETER,

  decompose(desiredState: Record<string, unknown>): PricingLineItem[] {
    const tier = String(desiredState[CfnKey.TIER] ?? "Standard").toLowerCase();

    // Standard tier is free — no billable components
    if (tier === "standard") {
      return [];
    }

    const items: PricingLineItem[] = [];

    // 1. Parameter storage (per parameter per month)
    items.push({
      label: "Parameter storage",
      quantity: 1,
      unit: "parameter",
      serviceCode: "AWSSystemsManager",
      filters: [
        {
          Field: "productFamily",
          Value: "AWS Systems Manager",
          Type: "TERM_MATCH",
        },
        {
          Field: "usagetype",
          Value: "ParameterStorage-Advanced-Tier1",
          Type: "TERM_MATCH",
        },
      ],
      kind: "fixed",
      description: "Advanced tier",
      priceUnit: "/param-mo",
    });

    // 2. API calls (higher throughput)
    items.push({
      label: "API calls",
      quantity: 0,
      unit: "requests",
      serviceCode: "AWSSystemsManager",
      filters: [
        {
          Field: "productFamily",
          Value: "AWS Systems Manager",
          Type: "TERM_MATCH",
        },
        {
          Field: "usagetype",
          Value: "PS-GetParameter-Transactions-Tier1",
          Type: "TERM_MATCH",
        },
      ],
      kind: "usage_based",
      description: "higher throughput API",
      priceUnit: "/10K reqs",
    });

    return items;
  },
};
