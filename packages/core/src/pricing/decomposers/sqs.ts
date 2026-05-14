/**
 * SQS Pricing Decomposer — breaks an SQS queue into billable components.
 *
 *   1. Requests — per-million, rate depends on Standard vs FIFO.
 *      AWS Pricing API: serviceCode=AmazonSQS, productFamily=API Request,
 *      queueType=Standard|FIFO.
 *      NB: the old filter used productFamily=Queue which the Pricing API
 *      does NOT match — it returns productFamily="API Request" for SQS
 *      request-count items. Fixed by PD-3.
 *
 *   2. Data transfer out to the public internet — usage-based. Billed at
 *      the standard AWSDataTransfer rate (same as S3 / EC2 DTO), routed
 *      through the SDK bypass in breakdown.ts because the awslabs Pricing
 *      MCP cannot service AWSDataTransfer queries reliably (see story
 *      bug-s3-pricing-data-transfer-out-unavailable-2026-05-09 and the
 *      SDK_BYPASS_SERVICE_CODES comment in breakdown.ts). Only applies
 *      when consumers pull messages from outside the queue's region.
 *      Volume is workload-dependent and not knowable from desiredState,
 *      so the line item is emitted with quantity=0 and the advisor
 *      surfaces it as a "watch this if your consumers are in another
 *      region" reminder.
 *
 * @see Story 23.3 — original single-line-item decomposer
 * @see (f) 2026-04-09 — added the DTO line so SQS has the same
 *      plan-box shape as other request-based services (SNS Topic,
 *      API Gateway, DynamoDB).
 * @see PD-3 (2026-05-13) — fix Requests filter (Queue→API Request +
 *      queueType discriminator) and DTO service code (SQS→AWSDataTransfer)
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
import { PricingFilterValue as FV } from "../pricing-filter-values.js";
import { PriceUnit } from "../price-units.js";
import { LineItemLabel } from "../line-item-labels.js";
import { PricingUnit } from "../units.js";

export const sqsPricingDecomposer: PricingDecomposer = {
  resourceType: RESOURCE_TYPES.SQS_QUEUE,

  decompose(desiredState: Record<string, unknown>): PricingLineItem[] {
    const items: PricingLineItem[] = [];
    const queueName = String(desiredState[CfnKey.QUEUE_NAME] ?? "");
    const fifoFlag = desiredState[CfnKey.FIFO_QUEUE];
    const isFifo =
      fifoFlag === true || fifoFlag === "true" || queueName.endsWith(".fifo");

    // 1. Requests (per-million, rate depends on FIFO vs Standard).
    //
    // PD-3 fix: the correct productFamily for SQS request-count items in
    // the AWS Pricing API is "API Request" (NOT "Queue" / "FIFO Queue").
    // The queueType attribute discriminates Standard from FIFO so the
    // filter returns exactly one SKU per region and the extractor picks
    // up the right rate.
    //
    // Fixtures: sqsStandardRequests / sqsFifoRequests in pricing-sqs.ts
    // confirm the real API shape (productFamily="API Request",
    // queueType="Standard"|"FIFO", pricePerUnit=$0.0000004000|$0.0000005000).
    items.push({
      label: LineItemLabel.REQUESTS,
      quantity: 0,
      unit: PricingUnit.REQUESTS,
      serviceCode: SC.SQS,
      filters: [
        {
          Field: F.PRODUCT_FAMILY,
          Value: PF.API_REQUEST,
          Type: M.TERM_MATCH,
        },
        {
          Field: F.QUEUE_TYPE,
          Value: isFifo ? FV.QUEUE_TYPE_FIFO : FV.QUEUE_TYPE_STANDARD,
          Type: M.TERM_MATCH,
        },
      ],
      kind: K.USAGE_BASED,
      description: isFifo ? "FIFO queue" : "Standard queue",
      priceUnit: PriceUnit.PER_MILLION_REQS,
      scale: 1_000_000,
    });

    // 2. Data transfer out. SQS data transfer out of AWS to the
    //    public internet is billed at the standard AWSDataTransfer rate
    //    (~$0.09/GB tiered). In-region traffic between EC2/Lambda/ECS
    //    consumers and the queue is FREE and should not be counted here.
    //
    //    PD-3 fix: the old filter queried serviceCode=AmazonSQS with
    //    productFamily=Data Transfer — that combination returns no results
    //    from the pricing API. Data transfer out is always billed via
    //    serviceCode=AWSDataTransfer regardless of which AWS service
    //    generates the egress (matches S3 decomposer pattern).
    //
    //    The breakdown.ts SDK_BYPASS_SERVICE_CODES set routes
    //    AWSDataTransfer queries through the AWS SDK directly (the awslabs
    //    Pricing MCP cannot service these queries reliably).
    //
    //    The cost-advisor annotates this line with a "only fires if
    //    consumers are outside the queue's region" reminder at plan time,
    //    because in-region consumption is the overwhelming common case.
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
      description: "Data transfer out (only cross-region consumers)",
      priceUnit: PriceUnit.PER_GB,
    });

    return items;
  },
};
