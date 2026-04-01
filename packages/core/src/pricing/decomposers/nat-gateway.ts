/**
 * NAT Gateway Pricing Decomposer — breaks a NAT Gateway into billable components:
 * hourly rate and data processing.
 *
 * Both public and private connectivity types use the same pricing.
 *
 * @see Story 23.3
 */

import { CfnKey } from "../../config/cfn-keys.js";
import { RESOURCE_TYPES } from "../../config/resource-types.js";
import type {
  PricingDecomposer,
  PricingLineItem,
} from "../decomposer-types.js";

export const natGatewayPricingDecomposer: PricingDecomposer = {
  resourceType: RESOURCE_TYPES.EC2_NAT_GATEWAY,

  decompose(_desiredState: Record<string, unknown>): PricingLineItem[] {
    const items: PricingLineItem[] = [];

    // 1. Hourly rate (per gateway)
    items.push({
      label: "Hourly rate",
      quantity: 1,
      unit: "gateway",
      serviceCode: "AmazonEC2",
      filters: [
        { Field: "productFamily", Value: "NAT Gateway", Type: "TERM_MATCH" },
        {
          Field: "usagetype",
          Value: "NatGateway-Hours",
          Type: "TERM_MATCH",
        },
      ],
      kind: "fixed",
      description:
        "NAT Gateway" +
        (_desiredState[CfnKey.CONNECTIVITY_TYPE]
          ? ` (${_desiredState[CfnKey.CONNECTIVITY_TYPE]})`
          : ""),
      priceUnit: "/hr",
    });

    // 2. Data processing (per GB)
    items.push({
      label: "Data processing",
      quantity: 0,
      unit: "GB",
      serviceCode: "AmazonEC2",
      filters: [
        { Field: "productFamily", Value: "NAT Gateway", Type: "TERM_MATCH" },
        {
          Field: "usagetype",
          Value: "NatGateway-Bytes",
          Type: "TERM_MATCH",
        },
      ],
      kind: "usage_based",
      description: "per GB processed",
      priceUnit: "/GB",
    });

    return items;
  },
};
