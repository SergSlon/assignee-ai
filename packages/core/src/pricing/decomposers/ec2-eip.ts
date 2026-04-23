/**
 * EIP Pricing Decomposer — one line item: per-hour rate while unattached.
 *
 * e98.W5.N5 (B-03) — promoted to first-class alongside the plugin.
 * EIPs are free while attached to a running EC2 instance or NAT
 * Gateway; the hourly rate only bills on unattached addresses.
 * Plan-time we can't tell from desiredState whether the EIP will
 * end up attached, so we emit a single fixed hourly line item and
 * the cost-advisor annotates with a "free when attached" reminder.
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
import { PricingFilterValue as FV } from "../pricing-filter-values.js";
import { PriceUnit } from "../price-units.js";
import { LineItemLabel } from "../line-item-labels.js";
import { PricingUnit } from "../units.js";

export const ec2EipPricingDecomposer: PricingDecomposer = {
  resourceType: RESOURCE_TYPES.EC2_EIP,

  decompose(_desiredState: Record<string, unknown>): PricingLineItem[] {
    return [
      {
        label: LineItemLabel.HOURLY_RATE,
        quantity: 1,
        unit: PricingUnit.ADDRESS,
        serviceCode: SC.EC2,
        filters: [
          {
            Field: F.PRODUCT_FAMILY,
            Value: PF.IP_ADDRESS,
            Type: M.TERM_MATCH,
          },
          {
            Field: F.GROUP,
            Value: FV.ELASTIC_IP_ADDRESS,
            Type: M.TERM_MATCH,
          },
        ],
        kind: K.FIXED,
        description:
          "Elastic IP (free while attached to a running EC2 / NAT Gateway; bills when unattached)",
        priceUnit: PriceUnit.PER_HOUR,
      },
    ];
  },
};
