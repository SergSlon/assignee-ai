/**
 * API Gateway V2 Pricing Decomposer — breaks an HTTP API or WebSocket API
 * into billable components: requests/messages, data transfer/connection minutes.
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

export const apigatewayV2PricingDecomposer: PricingDecomposer = {
  resourceType: RESOURCE_TYPES.APIGATEWAYV2_API,

  decompose(desiredState: Record<string, unknown>): PricingLineItem[] {
    const items: PricingLineItem[] = [];
    const protocolType = String(desiredState[CfnKey.PROTOCOL_TYPE] ?? "HTTP");

    if (protocolType === "WEBSOCKET") {
      // 1. Messages
      items.push({
        label: "Messages",
        quantity: 0,
        unit: "messages",
        serviceCode: SC.API_GATEWAY,
        filters: [
          { Field: F.PRODUCT_FAMILY, Value: PF.WEBSOCKET, Type: M.TERM_MATCH },
          {
            Field: F.USAGE_TYPE,
            Value: "ApiGatewayMessage",
            Type: M.TERM_MATCH,
          },
        ],
        kind: K.USAGE_BASED,
        description: "per million",
        priceUnit: "/M msgs",
        scale: 1_000_000,
      });

      // 2. Connection minutes
      items.push({
        label: "Connection minutes",
        quantity: 0,
        unit: "minutes",
        serviceCode: SC.API_GATEWAY,
        filters: [
          { Field: F.PRODUCT_FAMILY, Value: PF.WEBSOCKET, Type: M.TERM_MATCH },
          {
            Field: F.USAGE_TYPE,
            Value: "ApiGatewayMinute",
            Type: M.TERM_MATCH,
          },
        ],
        kind: K.USAGE_BASED,
        description: "per million",
        priceUnit: "/M mins",
        scale: 1_000_000,
      });
    } else {
      // HTTP API (default)

      // 1. Requests
      items.push({
        label: "Requests",
        quantity: 0,
        unit: "requests",
        serviceCode: SC.API_GATEWAY,
        filters: [
          { Field: F.PRODUCT_FAMILY, Value: PF.API_CALLS, Type: M.TERM_MATCH },
          {
            Field: F.USAGE_TYPE,
            Value: "ApiGatewayHttpRequest",
            Type: M.TERM_MATCH,
          },
        ],
        kind: K.USAGE_BASED,
        description: "per million",
        priceUnit: "/M reqs",
        scale: 1_000_000,
      });

      // 2. Data transfer out
      items.push({
        label: "Data transfer out",
        quantity: 0,
        unit: "GB",
        serviceCode: SC.DATA_TRANSFER,
        filters: [
          {
            Field: F.PRODUCT_FAMILY,
            Value: PF.DATA_TRANSFER,
            Type: M.TERM_MATCH,
          },
          {
            Field: F.FROM_LOCATION_TYPE,
            Value: "AWS Region",
            Type: M.TERM_MATCH,
          },
          { Field: F.TO_LOCATION_TYPE, Value: "External", Type: M.TERM_MATCH },
          { Field: F.TRANSFER_TYPE, Value: "AWS Outbound", Type: M.TERM_MATCH },
        ],
        kind: K.USAGE_BASED,
        description: "per GB",
        priceUnit: "/GB",
      });
    }

    return items;
  },
};
