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
  CostEstimateLabel,
} from "../filter-constants.js";

/**
 * Pricing strategy for AWS::KMS::Key (customer-managed keys).
 *
 * Pricing model:
 *   - Per-key storage: $1.00 per key per month (prorated to the hour).
 *     MultiRegion=true bills once PER REGION the key is replicated to.
 *   - API requests: $0.03 per 10,000 requests for symmetric
 *     Encrypt/Decrypt/GenerateDataKey; $0.10 per 10,000 for asymmetric
 *     and HMAC operations. Request volume is workload-dependent and
 *     not knowable from desiredState, so the MCP query is for the
 *     per-key storage line only — request fees bubble up via actual
 *     usage in the cost-advisor report.
 *   - AWS-managed keys (aws/ssm, aws/s3, etc.) are FREE. This strategy
 *     is for customer-managed keys (CMKs) where `Origin=AWS_KMS`.
 *
 * All prices queried from the Pricing MCP at runtime — zero hardcoded
 * dollar amounts per feedback_no_hardcoded_prices.
 */
export const kmsKeyPricingStrategy: PricingStrategy = {
  estimateLocal(_desiredState?: Record<string, unknown>): PricingEstimate {
    // Storage rate is fixed ($1/key/month), but we surface it via the
    // Pricing MCP like every other type so a future rate change
    // propagates automatically. estimateLocal returns N/A; the
    // decomposer + advisor do the real work.
    return { perMonth: null, label: CostEstimateLabel.NA };
  },
  mcpConfig(): McpPricingConfig {
    return {
      serviceCode: SC.KMS,
      filters: [
        {
          Field: F.PRODUCT_FAMILY,
          Value: PF.ENCRYPTION_KEY,
          Type: M.TERM_MATCH,
        },
      ],
      unit: "/key-month",
    };
  },
};
