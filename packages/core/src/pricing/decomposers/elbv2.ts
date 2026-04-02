/**
 * ELBv2 Pricing Decomposer — breaks an ALB/NLB into billable components:
 * hourly rate and LCU/NLCU-hours.
 *
 * @see Story 23.x
 */

import { CfnKey, AwsDefault } from "../../config/cfn-keys.js";
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
import { PricingUnit } from "../units.js";

export const elbv2PricingDecomposer: PricingDecomposer = {
  resourceType: RESOURCE_TYPES.ELBV2_LOAD_BALANCER,

  decompose(desiredState: Record<string, unknown>): PricingLineItem[] {
    const items: PricingLineItem[] = [];
    const lbType = String(
      desiredState[CfnKey.TYPE] ?? AwsDefault.LB_TYPE_APPLICATION,
    ).toLowerCase();

    if (lbType === "network") {
      // NLB hourly rate
      items.push({
        label: LineItemLabel.HOURLY,
        quantity: 1,
        unit: PricingUnit.NLB,
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
        priceUnit: PriceUnit.PER_HOUR,
      });

      // NLB NLCU-hours
      items.push({
        label: LineItemLabel.NLCU,
        quantity: 0,
        unit: PricingUnit.NLCU_HR,
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
        priceUnit: PriceUnit.PER_NLCU_HOUR,
      });
    } else {
      // ALB hourly rate
      items.push({
        label: LineItemLabel.HOURLY,
        quantity: 1,
        unit: PricingUnit.ALB,
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
        priceUnit: PriceUnit.PER_HOUR,
      });

      // ALB LCU-hours
      items.push({
        label: LineItemLabel.LCU,
        quantity: 0,
        unit: PricingUnit.LCU_HR,
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
        priceUnit: PriceUnit.PER_LCU_HOUR,
      });
    }

    return items;
  },
};
