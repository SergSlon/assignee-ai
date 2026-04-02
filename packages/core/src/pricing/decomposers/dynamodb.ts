/**
 * DynamoDB Pricing Decomposer — breaks a DynamoDB table into billable components:
 * read capacity, write capacity, and storage.
 * Adapts line items based on billing mode (on-demand vs provisioned).
 *
 * @see Story 24.1
 */

import { CfnKey, AwsDefault } from "../../config/cfn-keys.js";
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
import { PriceUnit } from "../price-units.js";
import { LineItemLabel } from "../line-item-labels.js";
import { PricingFilterValue as FV } from "../pricing-filter-values.js";
import { PricingUnit } from "../units.js";

export const dynamodbPricingDecomposer: PricingDecomposer = {
  resourceType: RESOURCE_TYPES.DYNAMODB_TABLE,

  decompose(desiredState: Record<string, unknown>): PricingLineItem[] {
    const items: PricingLineItem[] = [];
    const billingMode =
      (desiredState[CfnKey.BILLING_MODE] as string | undefined) ??
      AwsDefault.BILLING_PAY_PER_REQUEST;
    const isProvisioned = billingMode === AwsDefault.BILLING_PROVISIONED;

    if (isProvisioned) {
      const throughput = desiredState[CfnKey.PROVISIONED_THROUGHPUT] as
        | Record<string, unknown>
        | undefined;
      const rcu = Number(throughput?.[CfnKey.READ_CAPACITY_UNITS] ?? 5);
      const wcu = Number(throughput?.[CfnKey.WRITE_CAPACITY_UNITS] ?? 5);

      // 1. Read capacity (provisioned)
      items.push({
        label: LineItemLabel.READ_CAPACITY,
        quantity: rcu,
        unit: PricingUnit.RCU,
        serviceCode: SC.DYNAMODB,
        filters: [
          {
            Field: F.PRODUCT_FAMILY,
            Value: PF.PROVISIONED_IOPS,
            Type: M.TERM_MATCH,
          },
          { Field: F.GROUP, Value: FV.DDB_READ_UNITS, Type: M.TERM_MATCH },
        ],
        kind: K.FIXED,
        description: `${rcu} RCUs`,
        priceUnit: PriceUnit.PER_RCU_HOUR,
      });

      // 2. Write capacity (provisioned)
      items.push({
        label: LineItemLabel.WRITE_CAPACITY,
        quantity: wcu,
        unit: PricingUnit.WCU,
        serviceCode: SC.DYNAMODB,
        filters: [
          {
            Field: F.PRODUCT_FAMILY,
            Value: PF.PROVISIONED_IOPS,
            Type: M.TERM_MATCH,
          },
          { Field: F.GROUP, Value: FV.DDB_WRITE_UNITS, Type: M.TERM_MATCH },
        ],
        kind: K.FIXED,
        description: `${wcu} WCUs`,
        priceUnit: PriceUnit.PER_WCU_HOUR,
      });
    } else {
      // 1. Read request units (on-demand)
      items.push({
        label: LineItemLabel.READ_CAPACITY,
        quantity: 0,
        unit: PricingUnit.REQUESTS,
        serviceCode: SC.DYNAMODB,
        filters: [
          {
            Field: F.PRODUCT_FAMILY,
            Value: PF.PAY_PER_REQUEST,
            Type: M.TERM_MATCH,
          },
          { Field: F.GROUP, Value: FV.DDB_READ_UNITS, Type: M.TERM_MATCH },
        ],
        kind: K.USAGE_BASED,
        description: "per million read request units",
        priceUnit: PriceUnit.PER_MILLION_READ_REQS,
      });

      // 2. Write request units (on-demand)
      items.push({
        label: LineItemLabel.WRITE_CAPACITY,
        quantity: 0,
        unit: PricingUnit.REQUESTS,
        serviceCode: SC.DYNAMODB,
        filters: [
          {
            Field: F.PRODUCT_FAMILY,
            Value: PF.PAY_PER_REQUEST,
            Type: M.TERM_MATCH,
          },
          { Field: F.GROUP, Value: FV.DDB_WRITE_UNITS, Type: M.TERM_MATCH },
        ],
        kind: K.USAGE_BASED,
        description: "per million write request units",
        priceUnit: PriceUnit.PER_MILLION_WRITE_REQS,
      });
    }

    // 3. Storage (always usage-based, per GB-month)
    items.push({
      label: LineItemLabel.STORAGE,
      quantity: 0,
      unit: PricingUnit.GB,
      serviceCode: SC.DYNAMODB,
      filters: [
        {
          Field: F.PRODUCT_FAMILY,
          Value: PF.DATABASE_STORAGE,
          Type: M.TERM_MATCH,
        },
        {
          Field: F.USAGE_TYPE,
          Value: FV.TIMED_STORAGE_BYTE_HRS,
          Type: M.TERM_MATCH,
        },
      ],
      kind: K.USAGE_BASED,
      description: "per GB-month",
      priceUnit: PriceUnit.PER_GB_MONTH,
    });

    return items;
  },
};
