import type {
  PricingStrategy,
  PricingEstimate,
  McpPricingConfig,
} from "../types.js";

const DEFAULT_INSTANCE_TYPE = "t3.micro";
const EXTENDED_TIMEOUT_MS = 8000;

export const ec2PricingStrategy: PricingStrategy = {
  estimateLocal(): PricingEstimate {
    return { perMonth: null, label: "N/A" };
  },
  mcpConfig(desiredState?: Record<string, unknown>): McpPricingConfig {
    const instanceType =
      (desiredState?.["InstanceType"] as string | undefined) ??
      DEFAULT_INSTANCE_TYPE;
    return {
      serviceCode: "AmazonEC2",
      filters: [
        {
          Field: "productFamily",
          Value: "Compute Instance",
          Type: "TERM_MATCH",
        },
        { Field: "instanceType", Value: instanceType, Type: "TERM_MATCH" },
        { Field: "operatingSystem", Value: "Linux", Type: "TERM_MATCH" },
        { Field: "tenancy", Value: "Shared", Type: "TERM_MATCH" },
        { Field: "capacitystatus", Value: "Used", Type: "TERM_MATCH" },
        { Field: "preInstalledSw", Value: "NA", Type: "TERM_MATCH" },
      ],
      unit: "/hour",
      timeoutMs: EXTENDED_TIMEOUT_MS,
    };
  },
};
