/**
 * ELBv2 Pricing Decomposer — breaks an ALB/NLB into billable components:
 * hourly rate and LCU/NLCU-hours.
 *
 * @see Story 23.x
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

export const elbv2PricingDecomposer: PricingDecomposer = {
  resourceType: RESOURCE_TYPES.ELBV2_LOAD_BALANCER,

  decompose(desiredState: Record<string, unknown>): PricingLineItem[] {
    const items: PricingLineItem[] = [];
    const lbType = String(
      desiredState[CfnKey.TYPE] ?? "application",
    ).toLowerCase();

    if (lbType === "network") {
      // NLB hourly rate
      items.push({
        label: "Hourly",
        quantity: 1,
        unit: "NLB",
        serviceCode: SC.ELB,
        filters: [
          {
            Field: F.PRODUCT_FAMILY,
            Value: PF.LOAD_BALANCER_NETWORK,
            Type: M.TERM_MATCH,
          },
        ],
        kind: K.FIXED,
        description: "Network Load Balancer",
        priceUnit: "/hr",
      });

      // NLB NLCU-hours
      items.push({
        label: "NLCU",
        quantity: 0,
        unit: "NLCU-hr",
        serviceCode: SC.ELB,
        filters: [
          {
            Field: F.PRODUCT_FAMILY,
            Value: PF.LOAD_BALANCER_NETWORK,
            Type: M.TERM_MATCH,
          },
        ],
        kind: K.USAGE_BASED,
        description: "NLCU-hours",
        priceUnit: "/NLCU-hr",
      });
    } else {
      // ALB hourly rate
      items.push({
        label: "Hourly",
        quantity: 1,
        unit: "ALB",
        serviceCode: SC.ELB,
        filters: [
          {
            Field: F.PRODUCT_FAMILY,
            Value: PF.LOAD_BALANCER_APPLICATION,
            Type: M.TERM_MATCH,
          },
        ],
        kind: K.FIXED,
        description: "Application Load Balancer",
        priceUnit: "/hr",
      });

      // ALB LCU-hours
      items.push({
        label: "LCU",
        quantity: 0,
        unit: "LCU-hr",
        serviceCode: SC.ELB,
        filters: [
          {
            Field: F.PRODUCT_FAMILY,
            Value: PF.LOAD_BALANCER_APPLICATION,
            Type: M.TERM_MATCH,
          },
        ],
        kind: K.USAGE_BASED,
        description: "LCU-hours",
        priceUnit: "/LCU-hr",
      });
    }

    return items;
  },
};
