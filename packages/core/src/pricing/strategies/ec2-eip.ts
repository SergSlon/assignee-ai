import type {
  PricingStrategy,
  PricingEstimate,
  McpPricingConfig,
} from "../types.js";
import {
  PricingField as F,
  PricingMatchType as M,
  PricingProductFamily as PF,
  PricingServiceCode as SC,
} from "../filter-constants.js";
import { PricingFilterValue as FV } from "../pricing-filter-values.js";
import { PriceUnit } from "../price-units.js";

/**
 * Pricing strategy for AWS::EC2::EIP.
 *
 * e98.W5.N5 (B-03) — EIP promoted to first-class. The pricing
 * estimate is intentionally conservative: unattached EIPs bill at
 * ~$0.005/hour (~$3.60/month), but EIPs attached to a running
 * EC2 instance or NAT Gateway are free. The plan-time estimator
 * cannot reliably predict attach state from desiredState alone
 * (the attach happens via a separate AssociationId after create),
 * so we report the per-hour rate and surface the "free when
 * attached" caveat in cost-advisor prose.
 *
 * All prices come from the Pricing MCP at runtime — zero hardcoded
 * dollar amounts (per feedback_no_hardcoded_prices).
 */
export const ec2EipPricingStrategy: PricingStrategy = {
  estimateLocal(): PricingEstimate {
    return {
      perMonth: null,
      label:
        "~$3.60/mo when unattached; free when attached to a running target",
      source: "fallback",
    };
  },
  mcpConfig(): McpPricingConfig {
    return {
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
      unit: PriceUnit.PER_HOUR_LONG,
    };
  },
};
