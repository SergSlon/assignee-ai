/**
 * ELBv2 Pricing Decomposer — breaks an ALB/NLB into billable components:
 * hourly rate and LCU/NLCU-hours.
 *
 * @see Story 23.x
 */

import { RESOURCE_TYPES } from "../../config/resource-types.js";
import type {
  PricingDecomposer,
  PricingLineItem,
} from "../decomposer-types.js";

export const elbv2PricingDecomposer: PricingDecomposer = {
  resourceType: RESOURCE_TYPES.ELBV2_LOAD_BALANCER,

  decompose(desiredState: Record<string, unknown>): PricingLineItem[] {
    const items: PricingLineItem[] = [];
    const lbType = String(desiredState["Type"] ?? "application").toLowerCase();

    if (lbType === "network") {
      // NLB hourly rate
      items.push({
        label: "Hourly",
        quantity: 1,
        unit: "NLB",
        serviceCode: "ElasticLoadBalancing",
        filters: [
          {
            Field: "productFamily",
            Value: "Load Balancer-Network",
            Type: "TERM_MATCH",
          },
        ],
        kind: "fixed",
        description: "Network Load Balancer",
        priceUnit: "/hr",
      });

      // NLB NLCU-hours
      items.push({
        label: "NLCU",
        quantity: 0,
        unit: "NLCU-hr",
        serviceCode: "ElasticLoadBalancing",
        filters: [
          {
            Field: "productFamily",
            Value: "Load Balancer-Network",
            Type: "TERM_MATCH",
          },
        ],
        kind: "usage_based",
        description: "NLCU-hours",
        priceUnit: "/NLCU-hr",
      });
    } else {
      // ALB hourly rate
      items.push({
        label: "Hourly",
        quantity: 1,
        unit: "ALB",
        serviceCode: "ElasticLoadBalancing",
        filters: [
          {
            Field: "productFamily",
            Value: "Load Balancer-Application",
            Type: "TERM_MATCH",
          },
        ],
        kind: "fixed",
        description: "Application Load Balancer",
        priceUnit: "/hr",
      });

      // ALB LCU-hours
      items.push({
        label: "LCU",
        quantity: 0,
        unit: "LCU-hr",
        serviceCode: "ElasticLoadBalancing",
        filters: [
          {
            Field: "productFamily",
            Value: "Load Balancer-Application",
            Type: "TERM_MATCH",
          },
        ],
        kind: "usage_based",
        description: "LCU-hours",
        priceUnit: "/LCU-hr",
      });
    }

    return items;
  },
};
