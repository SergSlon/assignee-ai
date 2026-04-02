/**
 * CloudWatch Logs Pricing Decomposer — breaks a log group into billable components:
 * ingestion and storage pricing varies by Standard vs Infrequent Access class.
 *
 * @see Story 23.3
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
import { PriceUnit } from "../price-units.js";
import { LineItemLabel } from "../line-item-labels.js";
import { PricingUnit } from "../units.js";

export const logsPricingDecomposer: PricingDecomposer = {
  resourceType: RESOURCE_TYPES.LOGS_LOG_GROUP,

  decompose(desiredState: Record<string, unknown>): PricingLineItem[] {
    const items: PricingLineItem[] = [];
    const logGroupClass = String(
      desiredState[CfnKey.LOG_GROUP_CLASS] ?? "STANDARD",
    );
    const isInfrequent = logGroupClass === "INFREQUENT_ACCESS";

    // 1. Log ingestion
    items.push({
      label: LineItemLabel.LOG_INGESTION,
      quantity: 0,
      unit: PricingUnit.GB,
      serviceCode: SC.CLOUDWATCH,
      filters: [
        {
          Field: F.PRODUCT_FAMILY,
          Value: PF.DATA_PAYLOAD,
          Type: M.TERM_MATCH,
        },
        {
          Field: F.USAGE_TYPE,
          Value: isInfrequent
            ? "CW:LogInfrequentAccess-DataProcessing-Bytes"
            : "CW:DataProcessing-Bytes",
          Type: M.TERM_MATCH,
        },
      ],
      kind: K.USAGE_BASED,
      description: isInfrequent ? "Infrequent Access class" : "Standard class",
      priceUnit: PriceUnit.PER_GB_INGESTED,
    });

    // 2. Log storage
    items.push({
      label: LineItemLabel.LOG_STORAGE,
      quantity: 0,
      unit: PricingUnit.GB,
      serviceCode: SC.CLOUDWATCH,
      filters: [
        {
          Field: F.PRODUCT_FAMILY,
          Value: PF.STORAGE_SNAPSHOT,
          Type: M.TERM_MATCH,
        },
        {
          Field: F.USAGE_TYPE,
          Value: isInfrequent
            ? "CW:LogInfrequentAccess-DataStorage-Bytes"
            : "CW:DataStorage-Bytes",
          Type: M.TERM_MATCH,
        },
      ],
      kind: K.USAGE_BASED,
      description: "archived logs",
      priceUnit: PriceUnit.PER_GB_MONTH,
    });

    return items;
  },
};
