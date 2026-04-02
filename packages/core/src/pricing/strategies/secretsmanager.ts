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

/**
 * Pricing strategy for AWS::SecretsManager::Secret.
 *
 * Pricing model:
 *  - Per secret: $0.40/secret/month
 *  - API calls: $0.05 per 10,000 API calls
 *  - No free tier
 *
 * All prices queried from Pricing MCP at runtime — zero hardcoded dollar amounts.
 */
export const secretsManagerPricingStrategy: PricingStrategy = {
  estimateLocal(): PricingEstimate {
    return { perMonth: null, label: "N/A" };
  },
  mcpConfig(): McpPricingConfig {
    return {
      serviceCode: SC.SECRETS_MANAGER,
      filters: [
        {
          Field: F.PRODUCT_FAMILY,
          Value: PF.SECRET,
          Type: M.TERM_MATCH,
        },
      ],
      unit: "/secret-month",
    };
  },
};
