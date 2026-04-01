/**
 * DynamoDB Pricing Decomposer — breaks a DynamoDB table into billable components:
 * read capacity, write capacity, and storage.
 * Adapts line items based on billing mode (on-demand vs provisioned).
 *
 * @see Story 24.1
 */

import { CfnKey } from "../../config/cfn-keys.js";
import { RESOURCE_TYPES } from "../../config/resource-types.js";
import type {
  PricingDecomposer,
  PricingLineItem,
} from "../decomposer-types.js";

export const dynamodbPricingDecomposer: PricingDecomposer = {
  resourceType: RESOURCE_TYPES.DYNAMODB_TABLE,

  decompose(desiredState: Record<string, unknown>): PricingLineItem[] {
    const items: PricingLineItem[] = [];
    const billingMode =
      (desiredState[CfnKey.BILLING_MODE] as string | undefined) ??
      "PAY_PER_REQUEST";
    const isProvisioned = billingMode === "PROVISIONED";

    if (isProvisioned) {
      const throughput = desiredState[CfnKey.PROVISIONED_THROUGHPUT] as
        | Record<string, unknown>
        | undefined;
      const rcu = Number(throughput?.[CfnKey.READ_CAPACITY_UNITS] ?? 5);
      const wcu = Number(throughput?.[CfnKey.WRITE_CAPACITY_UNITS] ?? 5);

      // 1. Read capacity (provisioned)
      items.push({
        label: "Read capacity",
        quantity: rcu,
        unit: "RCU",
        serviceCode: "AmazonDynamoDB",
        filters: [
          {
            Field: "productFamily",
            Value: "Provisioned IOPS",
            Type: "TERM_MATCH",
          },
          { Field: "group", Value: "DDB-ReadUnits", Type: "TERM_MATCH" },
        ],
        kind: "fixed",
        description: `${rcu} RCUs`,
        priceUnit: "/RCU-hr",
      });

      // 2. Write capacity (provisioned)
      items.push({
        label: "Write capacity",
        quantity: wcu,
        unit: "WCU",
        serviceCode: "AmazonDynamoDB",
        filters: [
          {
            Field: "productFamily",
            Value: "Provisioned IOPS",
            Type: "TERM_MATCH",
          },
          { Field: "group", Value: "DDB-WriteUnits", Type: "TERM_MATCH" },
        ],
        kind: "fixed",
        description: `${wcu} WCUs`,
        priceUnit: "/WCU-hr",
      });
    } else {
      // 1. Read request units (on-demand)
      items.push({
        label: "Read capacity",
        quantity: 0,
        unit: "requests",
        serviceCode: "AmazonDynamoDB",
        filters: [
          {
            Field: "productFamily",
            Value: "Amazon DynamoDB PayPerRequest Throughput",
            Type: "TERM_MATCH",
          },
          { Field: "group", Value: "DDB-ReadUnits", Type: "TERM_MATCH" },
        ],
        kind: "usage_based",
        description: "per million read request units",
        priceUnit: "/M read reqs",
      });

      // 2. Write request units (on-demand)
      items.push({
        label: "Write capacity",
        quantity: 0,
        unit: "requests",
        serviceCode: "AmazonDynamoDB",
        filters: [
          {
            Field: "productFamily",
            Value: "Amazon DynamoDB PayPerRequest Throughput",
            Type: "TERM_MATCH",
          },
          { Field: "group", Value: "DDB-WriteUnits", Type: "TERM_MATCH" },
        ],
        kind: "usage_based",
        description: "per million write request units",
        priceUnit: "/M write reqs",
      });
    }

    // 3. Storage (always usage-based, per GB-month)
    items.push({
      label: "Storage",
      quantity: 0,
      unit: "GB",
      serviceCode: "AmazonDynamoDB",
      filters: [
        {
          Field: "productFamily",
          Value: "Database Storage",
          Type: "TERM_MATCH",
        },
        {
          Field: "usagetype",
          Value: "TimedStorage-ByteHrs",
          Type: "TERM_MATCH",
        },
      ],
      kind: "usage_based",
      description: "per GB-month",
      priceUnit: "/GB-mo",
    });

    return items;
  },
};
