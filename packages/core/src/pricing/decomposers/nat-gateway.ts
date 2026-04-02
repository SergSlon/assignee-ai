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
import {
  PricingField as F,
  PricingKind as K,
  PricingMatchType as M,
  PricingProductFamily as PF,
  PricingServiceCode as SC,
} from "../filter-constants.js";

export const natGatewayPricingDecomposer: PricingDecomposer = {
  resourceType: RESOURCE_TYPES.EC2_NAT_GATEWAY,

  decompose(_desiredState: Record<string, unknown>): PricingLineItem[] {
    const items: PricingLineItem[] = [];

    // 1. Hourly rate (per gateway)
    items.push({
      label: "Hourly rate",
      quantity: 1,
      unit: "gateway",
      serviceCode: SC.EC2,
      filters: [
        { Field: F.PRODUCT_FAMILY, Value: PF.NAT_GATEWAY, Type: M.TERM_MATCH },
        {
          Field: F.USAGE_TYPE,
          Value: "NatGateway-Hours",
          Type: M.TERM_MATCH,
        },
      ],
      kind: K.FIXED,
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
      serviceCode: SC.EC2,
      filters: [
        { Field: F.PRODUCT_FAMILY, Value: PF.NAT_GATEWAY, Type: M.TERM_MATCH },
        {
          Field: F.USAGE_TYPE,
          Value: "NatGateway-Bytes",
          Type: M.TERM_MATCH,
        },
      ],
      kind: K.USAGE_BASED,
      description: "per GB processed",
      priceUnit: "/GB",
    });

    return items;
  },
};
