/**
 * KMS Key Pricing Decomposer — breaks a CMK into billable components:
 * per-key storage (fixed $1/key/month, multiplied by region count for
 * multi-region keys) and API request fees (usage-based, not knowable
 * from desiredState so surfaced as a usage-based placeholder).
 *
 * @see A11 (2026-04-09)
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

export const kmsKeyPricingDecomposer: PricingDecomposer = {
  resourceType: RESOURCE_TYPES.KMS_KEY,

  decompose(desiredState: Record<string, unknown>): PricingLineItem[] {
    const items: PricingLineItem[] = [];

    // 1. Per-key storage fee. Multi-region primary keys bill once
    //    per region the key is replicated to, BUT the ReplicaKey
    //    resources (AWS::KMS::ReplicaKey) are separate
    //    CloudFormation resources that carry their own per-key fee.
    //    Here we only count the one key that THIS resource creates
    //    — the primary. Multi-region replicas land as separate
    //    ReplicaKey resources with their own decomposers (or the
    //    generic fallback).
    items.push({
      label: LineItemLabel.KEY_STORAGE,
      quantity: 1,
      unit: PricingUnit.KEY,
      serviceCode: SC.KMS,
      filters: [
        {
          Field: F.PRODUCT_FAMILY,
          Value: PF.ENCRYPTION_KEY,
          Type: M.TERM_MATCH,
        },
      ],
      kind: K.FIXED,
      description: "1 customer-managed key",
      priceUnit: PriceUnit.PER_KEY_MONTH,
    });

    // 2. API request fees. The per-10K rate differs between
    //    symmetric ($0.03) and asymmetric ($0.10 — ECC/RSA/HMAC)
    //    operations, but the request volume is workload-dependent
    //    and not knowable from the desiredState. Surface as a
    //    usage-based line item so the cost-advisor can annotate
    //    it with a request-volume reminder.
    const keySpec = String(desiredState["KeySpec"] ?? "SYMMETRIC_DEFAULT");
    const isSymmetric = keySpec === "SYMMETRIC_DEFAULT";
    items.push({
      label: LineItemLabel.API_CALLS,
      quantity: 0,
      unit: PricingUnit.REQUESTS,
      serviceCode: SC.KMS,
      filters: [
        { Field: F.PRODUCT_FAMILY, Value: PF.API_REQUEST, Type: M.TERM_MATCH },
      ],
      kind: K.USAGE_BASED,
      description: isSymmetric
        ? "per 10,000 symmetric requests"
        : "per 10,000 asymmetric requests",
      priceUnit: PriceUnit.PER_10K_REQS,
    });

    return items;
  },
};
