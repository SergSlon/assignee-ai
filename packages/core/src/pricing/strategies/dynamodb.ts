import type {
  PricingStrategy,
  PricingEstimate,
  McpPricingConfig,
} from "../types.js";
import { CfnKey, AwsDefault } from "../../config/cfn-keys.js";
import {
  PricingField as F,
  PricingMatchType as M,
  PricingProductFamily as PF,
  PricingServiceCode as SC,
} from "../filter-constants.js";
import { PricingFilterValue as FV } from "../pricing-filter-values.js";
import { PriceUnit } from "../price-units.js";

/**
 * DynamoDB pricing strategy.
 * On-demand: per-request pricing. Provisioned: per-WCU/RCU-hour.
 * All prices fetched from Pricing MCP at runtime — local fallback returns N/A.
 */
export const dynamodbPricingStrategy: PricingStrategy = {
  estimateLocal(desiredState?: Record<string, unknown>): PricingEstimate {
    const billingMode = desiredState?.[CfnKey.BILLING_MODE] as
      | string
      | undefined;
    const label =
      billingMode === AwsDefault.BILLING_PROVISIONED
        ? "Provisioned (per RCU/WCU-hour)"
        : "On-demand (per-request)";
    return { perMonth: null, label, source: "fallback" };
  },

  mcpConfig(desiredState?: Record<string, unknown>): McpPricingConfig | null {
    const billingMode = desiredState?.[CfnKey.BILLING_MODE] as
      | string
      | undefined;

    if (billingMode === AwsDefault.BILLING_PROVISIONED) {
      // Query for write capacity unit hourly rate (representative line item)
      return {
        serviceCode: SC.DYNAMODB,
        filters: [
          {
            Field: F.PRODUCT_FAMILY,
            Value: PF.PROVISIONED_IOPS,
            Type: M.TERM_MATCH,
          },
          { Field: F.GROUP, Value: FV.DDB_WRITE_UNITS, Type: M.TERM_MATCH },
        ],
        unit: PriceUnit.PER_WCU_HOUR,
      };
    }

    // On-demand: query write request units
    return {
      serviceCode: SC.DYNAMODB,
      filters: [
        {
          Field: F.PRODUCT_FAMILY,
          Value: PF.PAY_PER_REQUEST,
          Type: M.TERM_MATCH,
        },
        { Field: F.GROUP, Value: FV.DDB_WRITE_UNITS, Type: M.TERM_MATCH },
      ],
      unit: "/M write req",
    };
  },
};
