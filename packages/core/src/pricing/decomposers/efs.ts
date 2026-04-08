/**
 * EFS Pricing Decomposer — breaks an EFS file system into billable
 * components. For A1 (2026-04-08) we ship the headline Standard
 * storage line item only; three follow-up breakdowns are deferred:
 *
 *   1. Provisioned throughput (only when ThroughputMode === "provisioned",
 *      billed per MiB/s-month). Would require adding MIBPS to PricingUnit
 *      and PER_MIBPS_MONTH to PriceUnit for a rarely-used edge case.
 *   2. Backup cost — billed through AWS Backup on a separate service
 *      code (AWSBackup). The decomposer interface does not support
 *      cross-service line items today; BP-EFS-002 surfaces the cost
 *      trade-off at plan time instead.
 *   3. Lifecycle-managed IA transitions — depend on access patterns
 *      we cannot know pre-apply.
 *
 * @see A1 — first-class EFS support
 */

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

export const efsPricingDecomposer: PricingDecomposer = {
  resourceType: RESOURCE_TYPES.EFS_FILE_SYSTEM,

  decompose(_desiredState: Record<string, unknown>): PricingLineItem[] {
    const items: PricingLineItem[] = [];

    // Standard storage (per GB-month) — always present.
    items.push({
      label: LineItemLabel.STORAGE,
      quantity: 0,
      unit: PricingUnit.GB,
      serviceCode: SC.EFS,
      filters: [
        {
          Field: F.PRODUCT_FAMILY,
          Value: PF.STORAGE,
          Type: M.TERM_MATCH,
        },
      ],
      kind: K.USAGE_BASED,
      description: "Standard storage",
      priceUnit: PriceUnit.PER_GB_MONTH,
    });

    return items;
  },
};
