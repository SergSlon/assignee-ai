/**
 * CloudWatch Alarm Pricing Decomposer — breaks an alarm into billable components:
 * standard vs high-resolution alarm pricing based on evaluation period.
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

export const cloudWatchAlarmPricingDecomposer: PricingDecomposer = {
  resourceType: RESOURCE_TYPES.CLOUDWATCH_ALARM,

  decompose(desiredState: Record<string, unknown>): PricingLineItem[] {
    const items: PricingLineItem[] = [];
    const rawPeriod = desiredState[CfnKey.PERIOD];
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
      serviceCode: SC.CLOUDWATCH,
      filters: [
        { Field: F.PRODUCT_FAMILY, Value: PF.ALARM, Type: M.TERM_MATCH },
        {
          Field: F.ALARM_TYPE,
          Value: isHighRes ? "High Resolution" : "Standard",
          Type: M.TERM_MATCH,
        },
      ],
      kind: K.FIXED,
      description: isHighRes
        ? "High resolution (<60s period)"
        : "Standard resolution",
      priceUnit: "/alarm-mo",
    });

    return items;
  },
};
