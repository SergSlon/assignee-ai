/**
 * Lambda Pricing Decomposer — breaks a Lambda function into billable components:
 * requests per million, duration (GB-seconds), and CloudWatch Logs.
 *
 * @see Story 23.3
 */

import type {
  PricingDecomposer,
  PricingLineItem,
} from "../decomposer-types.js";

export const lambdaPricingDecomposer: PricingDecomposer = {
  resourceType: "AWS::Lambda::Function",

  decompose(desiredState: Record<string, unknown>): PricingLineItem[] {
    const items: PricingLineItem[] = [];
    const memoryMb = Number(desiredState["MemorySize"] ?? 128);

    // 1. Requests (per million) — use usagetype=Request to find request pricing
    items.push({
      label: "Requests",
      quantity: 0,
      unit: "requests",
      serviceCode: "AWSLambda",
      filters: [
        { Field: "productFamily", Value: "Serverless", Type: "TERM_MATCH" },
        { Field: "usagetype", Value: "Request", Type: "TERM_MATCH" },
      ],
      kind: "usage_based",
      description: "per million",
      priceUnit: "/M reqs",
      scale: 1_000_000,
    });

    // 2. Duration (GB-seconds) — use usagetype=Lambda-GB-Second
    items.push({
      label: "Duration",
      quantity: 0,
      unit: "GB-second",
      serviceCode: "AWSLambda",
      filters: [
        { Field: "productFamily", Value: "Serverless", Type: "TERM_MATCH" },
        { Field: "usagetype", Value: "Lambda-GB-Second", Type: "TERM_MATCH" },
      ],
      kind: "usage_based",
      description: `${memoryMb} MB, 100ms avg`,
      priceUnit: "/GB-s",
    });

    // 3. CloudWatch Logs (usage-based) — use usagetype for log ingestion
    items.push({
      label: "CloudWatch Logs",
      quantity: 0,
      unit: "GB",
      serviceCode: "AmazonCloudWatch",
      filters: [
        { Field: "productFamily", Value: "Data Payload", Type: "TERM_MATCH" },
        {
          Field: "usagetype",
          Value: "DataProcessing-Bytes",
          Type: "TERM_MATCH",
        },
      ],
      kind: "usage_based",
      description: "ingested",
      priceUnit: "/GB ingested",
    });

    return items;
  },
};
