import type {
  PricingStrategy,
  PricingEstimate,
  McpPricingConfig,
} from "../types.js";

const DEFAULT_INSTANCE_CLASS = "db.t3.micro";
const DEFAULT_ENGINE = "mysql";
const EXTENDED_TIMEOUT_MS = 8000;

export const rdsPricingStrategy: PricingStrategy = {
  estimateLocal(): PricingEstimate {
    return { perMonth: null, label: "N/A" };
  },
  mcpConfig(desiredState?: Record<string, unknown>): McpPricingConfig {
    const instanceClass =
      (desiredState?.["DBInstanceClass"] as string | undefined) ??
      DEFAULT_INSTANCE_CLASS;
    const engine =
      (desiredState?.["Engine"] as string | undefined) ?? DEFAULT_ENGINE;
    return {
      serviceCode: "AmazonRDS",
      filters: [
        {
          Field: "productFamily",
          Value: "Database Instance",
          Type: "TERM_MATCH",
        },
        { Field: "instanceType", Value: instanceClass, Type: "TERM_MATCH" },
        { Field: "databaseEngine", Value: engine, Type: "TERM_MATCH" },
        { Field: "deploymentOption", Value: "Single-AZ", Type: "TERM_MATCH" },
      ],
      unit: "/hour",
      timeoutMs: EXTENDED_TIMEOUT_MS,
    };
  },
};
