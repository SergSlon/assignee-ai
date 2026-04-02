/**
 * API Gateway V2 Pricing Decomposer — breaks an HTTP API or WebSocket API
 * into billable components: requests/messages, data transfer/connection minutes.
 *
 * @see Story 23.3
 */

import { CfnKey, AwsDefault } from "../../config/cfn-keys.js";
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

export const apigatewayV2PricingDecomposer: PricingDecomposer = {
  resourceType: RESOURCE_TYPES.APIGATEWAYV2_API,

  decompose(desiredState: Record<string, unknown>): PricingLineItem[] {
    const items: PricingLineItem[] = [];
    const protocolType = String(
      desiredState[CfnKey.PROTOCOL_TYPE] ?? AwsDefault.PROTOCOL_HTTP,
    );

    if (protocolType === AwsDefault.PROTOCOL_WEBSOCKET) {
      // 1. Messages
      items.push({
        label: LineItemLabel.MESSAGES,
        quantity: 0,
        unit: PricingUnit.MESSAGES,
        serviceCode: SC.API_GATEWAY,
        filters: [
          { Field: F.PRODUCT_FAMILY, Value: PF.WEBSOCKET, Type: M.TERM_MATCH },
          {
            Field: F.USAGE_TYPE,
            Value: FV.API_GATEWAY_MESSAGE,
            Type: M.TERM_MATCH,
          },
        ],
        kind: K.USAGE_BASED,
        description: DecomposerDescription.PER_MILLION,
        priceUnit: PriceUnit.PER_MILLION_MSGS,
        scale: 1_000_000,
      });

      // 2. Connection minutes
      items.push({
        label: LineItemLabel.CONNECTION_MINUTES,
        quantity: 0,
        unit: PricingUnit.MINUTES,
        serviceCode: SC.API_GATEWAY,
        filters: [
          { Field: F.PRODUCT_FAMILY, Value: PF.WEBSOCKET, Type: M.TERM_MATCH },
          {
            Field: F.USAGE_TYPE,
            Value: FV.API_GATEWAY_MINUTE,
            Type: M.TERM_MATCH,
          },
        ],
        kind: K.USAGE_BASED,
        description: DecomposerDescription.PER_MILLION,
        priceUnit: PriceUnit.PER_MILLION_MINS,
        scale: 1_000_000,
      });
    } else {
      // HTTP API (default)

      // 1. Requests
      items.push({
        label: LineItemLabel.REQUESTS,
        quantity: 0,
        unit: PricingUnit.REQUESTS,
        serviceCode: SC.API_GATEWAY,
        filters: [
          { Field: F.PRODUCT_FAMILY, Value: PF.API_CALLS, Type: M.TERM_MATCH },
          {
            Field: F.USAGE_TYPE,
            Value: FV.API_GATEWAY_HTTP_REQUEST,
            Type: M.TERM_MATCH,
          },
        ],
        kind: K.USAGE_BASED,
        description: DecomposerDescription.PER_MILLION,
        priceUnit: PriceUnit.PER_MILLION_REQS,
        scale: 1_000_000,
      });

      // 2. Data transfer out
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
          { Field: F.TO_LOCATION_TYPE, Value: FV.EXTERNAL, Type: M.TERM_MATCH },
          {
            Field: F.TRANSFER_TYPE,
            Value: FV.AWS_OUTBOUND,
            Type: M.TERM_MATCH,
          },
        ],
        kind: K.USAGE_BASED,
        description: DecomposerDescription.PER_GB,
        priceUnit: PriceUnit.PER_GB,
      });
    }

    return items;
  },
};
