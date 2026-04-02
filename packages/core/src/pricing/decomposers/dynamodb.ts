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
import {
  PricingField as F,
  PricingKind as K,
  PricingMatchType as M,
  PricingProductFamily as PF,
  PricingServiceCode as SC,
} from "../filter-constants.js";

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
        serviceCode: SC.DYNAMODB,
        filters: [
          {
            Field: F.PRODUCT_FAMILY,
            Value: PF.PROVISIONED_IOPS,
            Type: M.TERM_MATCH,
          },
          { Field: F.GROUP, Value: "DDB-ReadUnits", Type: M.TERM_MATCH },
        ],
        kind: K.FIXED,
        description: `${rcu} RCUs`,
        priceUnit: "/RCU-hr",
      });

      // 2. Write capacity (provisioned)
      items.push({
        label: "Write capacity",
        quantity: wcu,
        unit: "WCU",
        serviceCode: SC.DYNAMODB,
        filters: [
          {
            Field: F.PRODUCT_FAMILY,
            Value: PF.PROVISIONED_IOPS,
            Type: M.TERM_MATCH,
          },
          { Field: F.GROUP, Value: "DDB-WriteUnits", Type: M.TERM_MATCH },
        ],
        kind: K.FIXED,
        description: `${wcu} WCUs`,
        priceUnit: "/WCU-hr",
      });
    } else {
      // 1. Read request units (on-demand)
      items.push({
        label: "Read capacity",
        quantity: 0,
        unit: "requests",
        serviceCode: SC.DYNAMODB,
        filters: [
          {
            Field: F.PRODUCT_FAMILY,
            Value: PF.PAY_PER_REQUEST,
            Type: M.TERM_MATCH,
          },
          { Field: F.GROUP, Value: "DDB-ReadUnits", Type: M.TERM_MATCH },
        ],
        kind: K.USAGE_BASED,
        description: "per million read request units",
        priceUnit: "/M read reqs",
      });

      // 2. Write request units (on-demand)
      items.push({
        label: "Write capacity",
        quantity: 0,
        unit: "requests",
        serviceCode: SC.DYNAMODB,
        filters: [
          {
            Field: F.PRODUCT_FAMILY,
            Value: PF.PAY_PER_REQUEST,
            Type: M.TERM_MATCH,
          },
          { Field: F.GROUP, Value: "DDB-WriteUnits", Type: M.TERM_MATCH },
        ],
        kind: K.USAGE_BASED,
        description: "per million write request units",
        priceUnit: "/M write reqs",
      });
    }

    // 3. Storage (always usage-based, per GB-month)
    items.push({
      label: "Storage",
      quantity: 0,
      unit: "GB",
      serviceCode: SC.DYNAMODB,
      filters: [
        {
          Field: F.PRODUCT_FAMILY,
          Value: PF.DATABASE_STORAGE,
          Type: M.TERM_MATCH,
        },
        {
          Field: F.USAGE_TYPE,
          Value: "TimedStorage-ByteHrs",
          Type: M.TERM_MATCH,
        },
      ],
      kind: K.USAGE_BASED,
      description: "per GB-month",
      priceUnit: "/GB-mo",
    });

    return items;
  },
};
