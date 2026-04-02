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
      label: "Log ingestion",
      quantity: 0,
      unit: "GB",
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
      priceUnit: "/GB ingested",
    });

    // 2. Log storage
    items.push({
      label: "Log storage",
      quantity: 0,
      unit: "GB",
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
      priceUnit: "/GB-mo",
    });

    return items;
  },
};
