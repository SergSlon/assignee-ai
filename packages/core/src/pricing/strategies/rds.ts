import type {
  PricingStrategy,
  PricingEstimate,
  McpPricingConfig,
} from "../types.js";

import { EXTENDED_TIMEOUT_MS } from "../constants.js";
import { CfnKey, AwsDefault } from "../../config/cfn-keys.js";
import {
  PricingField as F,
  PricingMatchType as M,
  PricingProductFamily as PF,
  PricingServiceCode as SC,
  CostEstimateLabel,
} from "../filter-constants.js";
import { PricingFilterValue as FV } from "../pricing-filter-values.js";
import { PriceUnit } from "../price-units.js";

const DEFAULT_INSTANCE_CLASS = AwsDefault.DB_INSTANCE_CLASS;
const DEFAULT_ENGINE = AwsDefault.RDS_ENGINE_MYSQL;

export const rdsPricingStrategy: PricingStrategy = {
  estimateLocal(): PricingEstimate {
    return { perMonth: null, label: CostEstimateLabel.NA, source: "fallback" };
  },
  mcpConfig(desiredState?: Record<string, unknown>): McpPricingConfig {
    const instanceClass =
      (desiredState?.[CfnKey.DB_INSTANCE_CLASS] as string | undefined) ??
      DEFAULT_INSTANCE_CLASS;
    const engine =
      (desiredState?.[CfnKey.ENGINE] as string | undefined) ?? DEFAULT_ENGINE;
    return {
      serviceCode: SC.RDS,
      filters: [
        {
          Field: F.PRODUCT_FAMILY,
          Value: PF.DATABASE_INSTANCE,
          Type: M.TERM_MATCH,
        },
        { Field: F.INSTANCE_TYPE, Value: instanceClass, Type: M.TERM_MATCH },
        { Field: F.DATABASE_ENGINE, Value: engine, Type: M.TERM_MATCH },
        { Field: F.DEPLOYMENT_OPTION, Value: FV.SINGLE_AZ, Type: M.TERM_MATCH },
      ],
      unit: PriceUnit.PER_HOUR_LONG,
      timeoutMs: EXTENDED_TIMEOUT_MS,
    };
  },
};
