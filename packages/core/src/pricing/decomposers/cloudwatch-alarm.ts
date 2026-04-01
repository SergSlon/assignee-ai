/**
 * CloudWatch Alarm Pricing Decomposer — breaks an alarm into billable components:
 * standard vs high-resolution alarm pricing based on evaluation period.
 *
 * @see Story 23.3
 */

import { RESOURCE_TYPES } from "../../config/resource-types.js";
import type {
  PricingDecomposer,
  PricingLineItem,
} from "../decomposer-types.js";

export const cloudWatchAlarmPricingDecomposer: PricingDecomposer = {
  resourceType: RESOURCE_TYPES.CLOUDWATCH_ALARM,

  decompose(desiredState: Record<string, unknown>): PricingLineItem[] {
    const items: PricingLineItem[] = [];
    const rawPeriod = desiredState["Period"];
    const period =
      typeof rawPeriod === "number" || typeof rawPeriod === "string"
        ? Number(rawPeriod)
        : 300;
    const isHighRes = !isNaN(period) && period > 0 && period < 60;

    // 1. Alarm
    items.push({
      label: "Alarm",
      quantity: 1,
      unit: "alarm",
      serviceCode: "AmazonCloudWatch",
      filters: [
        { Field: "productFamily", Value: "Alarm", Type: "TERM_MATCH" },
        {
          Field: "alarmType",
          Value: isHighRes ? "High Resolution" : "Standard",
          Type: "TERM_MATCH",
        },
      ],
      kind: "fixed",
      description: isHighRes
        ? "High resolution (<60s period)"
        : "Standard resolution",
      priceUnit: "/alarm-mo",
    });

    return items;
  },
};
