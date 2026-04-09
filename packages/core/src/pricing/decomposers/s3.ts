/**
 * S3 Pricing Decomposer — breaks an S3 bucket into billable components.
 *
 * Always-on lines (4):
 *   1. Storage (Standard, per GB-month)
 *   2. PUT requests (per 1k)
 *   3. GET requests (per 1k)
 *   4. Data transfer out to public internet (per GB)
 *
 * Conditional lines (added (f) 2026-04-09):
 *   5. Intelligent-Tiering storage — when
 *      IntelligentTieringConfigurations is set with at least one
 *      enabled configuration. IT charges $0.0125/GB-month for the
 *      Frequent Access tier (vs $0.023 Standard) and an additional
 *      monitoring + automation fee per object. Surfacing the IT line
 *      separately makes the cost delta visible at plan time.
 *   6. Replication storage + PUT — when ReplicationConfiguration is
 *      set with at least one rule. Cross-region replication bills
 *      both the source-side replication PUT operations AND the
 *      destination-side storage at the standard rate (or whichever
 *      class the rule targets). Inter-region data transfer is
 *      charged separately at the destination region's inbound rate.
 *
 * @see Story 23.3 — original 4-line decomposer
 * @see (f) 2026-04-09 — IT + replication conditional lines
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
import { LineItemLabel, DecomposerDescription } from "../line-item-labels.js";
import { PricingFilterValue as FV } from "../pricing-filter-values.js";
import { PricingUnit } from "../units.js";

export const s3PricingDecomposer: PricingDecomposer = {
  resourceType: RESOURCE_TYPES.S3_BUCKET,

  decompose(desiredState: Record<string, unknown>): PricingLineItem[] {
    const items: PricingLineItem[] = [];

    // 1. Storage (per GB-month)
    items.push({
      label: LineItemLabel.STORAGE,
      quantity: 0,
      unit: PricingUnit.GB,
      serviceCode: SC.S3,
      filters: [
        { Field: F.PRODUCT_FAMILY, Value: PF.STORAGE, Type: M.TERM_MATCH },
        {
          Field: F.USAGE_TYPE,
          Value: FV.TIMED_STORAGE_BYTE_HRS,
          Type: M.TERM_MATCH,
        },
      ],
      kind: K.USAGE_BASED,
      description: DecomposerDescription.STANDARD,
      priceUnit: PriceUnit.PER_GB_MONTH,
    });

    // 2. PUT requests
    items.push({
      label: LineItemLabel.PUT_REQUESTS,
      quantity: 0,
      unit: PricingUnit.REQUESTS,
      serviceCode: SC.S3,
      filters: [
        { Field: F.PRODUCT_FAMILY, Value: PF.API_REQUEST, Type: M.TERM_MATCH },
        { Field: F.USAGE_TYPE, Value: FV.REQUESTS_TIER1, Type: M.TERM_MATCH },
      ],
      kind: K.USAGE_BASED,
      description: "per 1,000 requests",
      priceUnit: PriceUnit.PER_1000_REQS,
    });

    // 3. GET requests
    items.push({
      label: LineItemLabel.GET_REQUESTS,
      quantity: 0,
      unit: PricingUnit.REQUESTS,
      serviceCode: SC.S3,
      filters: [
        { Field: F.PRODUCT_FAMILY, Value: PF.API_REQUEST, Type: M.TERM_MATCH },
        { Field: F.USAGE_TYPE, Value: FV.REQUESTS_TIER2, Type: M.TERM_MATCH },
      ],
      kind: K.USAGE_BASED,
      description: "per 1,000 requests",
      priceUnit: PriceUnit.PER_1000_REQS,
    });

    // 4. Data transfer out
    items.push({
      label: LineItemLabel.DATA_TRANSFER_OUT,
      quantity: 0,
      unit: PricingUnit.GB,
      serviceCode: SC.DATA_TRANSFER,
      filters: [
        {
          Field: F.PRODUCT_FAMILY,
          Value: PF.DATA_TRANSFER,
          Type: M.TERM_MATCH,
        },
        {
          Field: F.FROM_LOCATION_TYPE,
          Value: FV.AWS_REGION,
          Type: M.TERM_MATCH,
        },
        {
          Field: F.TO_LOCATION_TYPE,
          Value: FV.TO_LOCATION_OTHER,
          Type: M.TERM_MATCH,
        },
        { Field: F.TRANSFER_TYPE, Value: FV.AWS_OUTBOUND, Type: M.TERM_MATCH },
      ],
      kind: K.USAGE_BASED,
      description: DecomposerDescription.PER_GB,
      priceUnit: PriceUnit.PER_GB,
    });

    // 5. Intelligent-Tiering storage (conditional). The plugin
    //    doesn't expose this field directly — generic-plugin users
    //    and advanced wizard users hand-edit it into desiredState.
    //    A non-empty IntelligentTieringConfigurations array means
    //    at least one IT rule will be applied at create time.
    const itConfigs = desiredState["IntelligentTieringConfigurations"];
    if (Array.isArray(itConfigs) && itConfigs.length > 0) {
      items.push({
        label: LineItemLabel.STORAGE,
        quantity: 0,
        unit: PricingUnit.GB,
        serviceCode: SC.S3,
        filters: [
          { Field: F.PRODUCT_FAMILY, Value: PF.STORAGE, Type: M.TERM_MATCH },
          {
            Field: F.USAGE_TYPE,
            Value: FV.TIMED_STORAGE_INT_BYTE_HRS_FREQ,
            Type: M.TERM_MATCH,
          },
        ],
        kind: K.USAGE_BASED,
        description: "Intelligent-Tiering (Frequent Access)",
        priceUnit: PriceUnit.PER_GB_MONTH,
      });
    }

    // 6. Replication (conditional). The plugin's EnableReplication
    //    boolean is transformed via toCfn into the CFN-shape
    //    ReplicationConfiguration object before this decomposer
    //    runs, so we look for the post-toCfn shape (an object with
    //    Rules: [...]). We emit TWO line items because replication
    //    bills both the source-side PUT operations and the
    //    destination-side storage.
    const replicationConfig = desiredState["ReplicationConfiguration"];
    const hasReplication =
      typeof replicationConfig === "object" &&
      replicationConfig !== null &&
      Array.isArray((replicationConfig as Record<string, unknown>)["Rules"]) &&
      ((replicationConfig as { Rules: unknown[] }).Rules.length ?? 0) > 0;
    if (hasReplication) {
      items.push({
        label: LineItemLabel.PUT_REQUESTS,
        quantity: 0,
        unit: PricingUnit.REQUESTS,
        serviceCode: SC.S3,
        filters: [
          {
            Field: F.PRODUCT_FAMILY,
            Value: PF.API_REQUEST,
            Type: M.TERM_MATCH,
          },
          {
            Field: F.USAGE_TYPE,
            Value: FV.REQUESTS_TIER1,
            Type: M.TERM_MATCH,
          },
        ],
        kind: K.USAGE_BASED,
        description: "Replication PUT operations (source side)",
        priceUnit: PriceUnit.PER_1000_REQS,
      });
      items.push({
        label: LineItemLabel.STORAGE,
        quantity: 0,
        unit: PricingUnit.GB,
        serviceCode: SC.S3,
        filters: [
          { Field: F.PRODUCT_FAMILY, Value: PF.STORAGE, Type: M.TERM_MATCH },
          {
            Field: F.USAGE_TYPE,
            Value: FV.TIMED_STORAGE_BYTE_HRS,
            Type: M.TERM_MATCH,
          },
        ],
        kind: K.USAGE_BASED,
        description: "Replication storage (destination side)",
        priceUnit: PriceUnit.PER_GB_MONTH,
      });
    }

    return items;
  },
};
