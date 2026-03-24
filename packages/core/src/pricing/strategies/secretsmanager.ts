import type {
  PricingStrategy,
  PricingEstimate,
  McpPricingConfig,
} from "../types.js";

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
      serviceCode: "AWSSecretsManager",
      filters: [
        {
          Field: "productFamily",
          Value: "Secret",
          Type: "TERM_MATCH",
        },
      ],
      unit: "/secret-month",
    };
  },
};
