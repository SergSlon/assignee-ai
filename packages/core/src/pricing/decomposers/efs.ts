/**
 * EFS Pricing Decomposer — breaks an EFS file system into billable
 * components.
 *
 *   1. Standard storage — always present ($0.30/GB-month in us-east-1).
 *   2. Provisioned throughput — conditional on
 *      ThroughputMode=provisioned. Emitted as a FIXED line item
 *      (not usage_based) because ProvisionedThroughputInMibps IS
 *      knowable from desiredState. Provisioned throughput is rare
 *      but expensive (~$6/MiB-s-month baseline); surfacing it as
 *      its own line item makes the cost visible at plan time.
 *
 * Still deferred:
 *   - Backup cost (billed through AWS Backup on a separate service
 *     code — the decomposer interface does not support cross-service
 *     line items today; BP-EFS-002 surfaces the cost trade-off at
 *     plan time instead).
 *   - Lifecycle-managed IA transitions (depend on access patterns
 *     we cannot know pre-apply — the cost-advisor surfaces the
 *     tier delta as awareness-only guidance).
 *
 * @see A1 (2026-04-08) — first-class EFS support (headline line)
 * @see (f) 2026-04-09 — provisioned-throughput conditional line
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

export const efsPricingDecomposer: PricingDecomposer = {
  resourceType: RESOURCE_TYPES.EFS_FILE_SYSTEM,

  decompose(desiredState: Record<string, unknown>): PricingLineItem[] {
    const items: PricingLineItem[] = [];

    // 1. Standard storage (per GB-month) — always present.
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

    // 2. Provisioned throughput — only when ThroughputMode is
    //    explicitly "provisioned". The bursting + elastic modes are
    //    bundled into the storage price and don't bill separately.
    //    ProvisionedThroughputInMibps IS knowable from desiredState
    //    so this is a FIXED line item, not usage_based — the user
    //    pays for the committed throughput whether they use it or
    //    not (that's the whole point of provisioned mode).
    const throughputMode = String(
      desiredState[CfnKey.THROUGHPUT_MODE] ?? "",
    ).toLowerCase();
    const isProvisioned = throughputMode === "provisioned";
    if (isProvisioned) {
      const mibpsRaw = desiredState[CfnKey.PROVISIONED_THROUGHPUT_IN_MIBPS];
      const mibps =
        typeof mibpsRaw === "number"
          ? mibpsRaw
          : typeof mibpsRaw === "string" && mibpsRaw.length > 0
            ? Number(mibpsRaw)
            : 0;
      items.push({
        label: LineItemLabel.PROVISIONED_THROUGHPUT,
        quantity: Number.isFinite(mibps) && mibps > 0 ? mibps : 0,
        unit: PricingUnit.MIBPS,
        serviceCode: SC.EFS,
        filters: [
          {
            Field: F.PRODUCT_FAMILY,
            Value: PF.STORAGE,
            Type: M.TERM_MATCH,
          },
        ],
        kind: K.FIXED,
        description: `Provisioned throughput (${mibps || "?"} MiB/s committed)`,
        priceUnit: PriceUnit.PER_MIBPS_MONTH,
      });
    }

    return items;
  },
};
