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
      serviceCode: "AmazonCloudWatch",
      filters: [
        {
          Field: "productFamily",
          Value: "Data Payload",
          Type: "TERM_MATCH",
        },
        {
          Field: "usagetype",
          Value: isInfrequent
            ? "CW:LogInfrequentAccess-DataProcessing-Bytes"
            : "CW:DataProcessing-Bytes",
          Type: "TERM_MATCH",
        },
      ],
      kind: "usage_based",
      description: isInfrequent ? "Infrequent Access class" : "Standard class",
      priceUnit: "/GB ingested",
    });

    // 2. Log storage
    items.push({
      label: "Log storage",
      quantity: 0,
      unit: "GB",
      serviceCode: "AmazonCloudWatch",
      filters: [
        {
          Field: "productFamily",
          Value: "Storage Snapshot",
          Type: "TERM_MATCH",
        },
        {
          Field: "usagetype",
          Value: isInfrequent
            ? "CW:LogInfrequentAccess-DataStorage-Bytes"
            : "CW:DataStorage-Bytes",
          Type: "TERM_MATCH",
        },
      ],
      kind: "usage_based",
      description: "archived logs",
      priceUnit: "/GB-mo",
    });

    return items;
  },
};
