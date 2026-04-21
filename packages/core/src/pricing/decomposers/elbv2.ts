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

// ── Story 92.1.e: ALB/NLB hourly + LCU usage-type disambiguation ────────
//
// The AWS Pricing API returns BOTH the hourly load-balancer-hours row and
// the LCU-hours row under the same `productFamily=Load Balancer-*`
// family. Without a `usagetype` filter the first row returned is not
// deterministic — the live fetch either matches the wrong price tier or
// silently returns nothing, producing the `pricing_unavailable` warnings
// cited in findings A-05, B-08 (ALB-price half), B-19, C-08, C-21, D-17.
//
// Pinning the usage-type narrows the match to a single row every time:
// `LoadBalancerUsage` → hourly ALB rate (~$0.0225/hr)
// `LCUUsage`          → per-LCU-hour rate (~$0.008/hr)
//
// These usage-type tokens are AWS Pricing API literals (verified against
// the captured `test-fixtures/mcp-mock-responses/pricing-elbv2.ts`
// fixture which mirrors a real `aws pricing get-products` response for
// `--service-code AWSELB`). The equivalent NLB tokens
// (`LoadBalancerUsage` + `LCUUsage`) carry the same semantics because
// AWS re-uses the usage-type family string across ALB and NLB; only the
// `productFamily` distinguishes the two.
const UsageType = {
  LOAD_BALANCER_USAGE: "LoadBalancerUsage",
  LCU_USAGE: "LCUUsage",
} as const;

export const elbv2PricingDecomposer: PricingDecomposer = {
  resourceType: RESOURCE_TYPES.ELBV2_LOAD_BALANCER,

  decompose(desiredState: Record<string, unknown>): PricingLineItem[] {
    const items: PricingLineItem[] = [];
    const lbType = String(
      desiredState[CfnKey.TYPE] ?? AwsDefault.LB_TYPE_APPLICATION,
    ).toLowerCase();

    if (lbType === "network") {
      // NLB hourly rate — `usagetype=LoadBalancerUsage` pins the hourly
      // row so the extractor doesn't accidentally resolve to the LCU
      // row published under the same productFamily.
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
          {
            Field: F.USAGE_TYPE,
            Value: UsageType.LOAD_BALANCER_USAGE,
            Type: M.TERM_MATCH,
          },
        ],
        kind: K.FIXED,
        description: "Network Load Balancer",
        priceUnit: PriceUnit.PER_HOUR,
      });

      // NLB NLCU-hours — `usagetype=LCUUsage` pins the LCU row.
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
          {
            Field: F.USAGE_TYPE,
            Value: UsageType.LCU_USAGE,
            Type: M.TERM_MATCH,
          },
        ],
        kind: K.USAGE_BASED,
        description: "NLCU-hours",
        priceUnit: PriceUnit.PER_NLCU_HOUR,
      });
    } else {
      // ALB hourly rate — `usagetype=LoadBalancerUsage` pins the hourly
      // row against the captured `pricing-elbv2.ts` fixture. Without
      // this filter the Pricing API returns both the hourly AND the
      // LCU rows, and `extractFirstTierPrice` used to resolve either.
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
          {
            Field: F.USAGE_TYPE,
            Value: UsageType.LOAD_BALANCER_USAGE,
            Type: M.TERM_MATCH,
          },
        ],
        kind: K.FIXED,
        description: "Application Load Balancer",
        priceUnit: PriceUnit.PER_HOUR,
      });

      // ALB LCU-hours — `usagetype=LCUUsage` pins the per-LCU row.
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
          {
            Field: F.USAGE_TYPE,
            Value: UsageType.LCU_USAGE,
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
