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
        serviceCode: "AmazonApiGateway",
        filters: [
          { Field: "productFamily", Value: "WebSocket", Type: "TERM_MATCH" },
          {
            Field: "usagetype",
            Value: "ApiGatewayMessage",
            Type: "TERM_MATCH",
          },
        ],
        kind: "usage_based",
        description: "per million",
        priceUnit: "/M msgs",
        scale: 1_000_000,
      });

      // 2. Connection minutes
      items.push({
        label: "Connection minutes",
        quantity: 0,
        unit: "minutes",
        serviceCode: "AmazonApiGateway",
        filters: [
          { Field: "productFamily", Value: "WebSocket", Type: "TERM_MATCH" },
          {
            Field: "usagetype",
            Value: "ApiGatewayMinute",
            Type: "TERM_MATCH",
          },
        ],
        kind: "usage_based",
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
        serviceCode: "AmazonApiGateway",
        filters: [
          { Field: "productFamily", Value: "API Calls", Type: "TERM_MATCH" },
          {
            Field: "usagetype",
            Value: "ApiGatewayHttpRequest",
            Type: "TERM_MATCH",
          },
        ],
        kind: "usage_based",
        description: "per million",
        priceUnit: "/M reqs",
        scale: 1_000_000,
      });

      // 2. Data transfer out
      items.push({
        label: "Data transfer out",
        quantity: 0,
        unit: "GB",
        serviceCode: "AWSDataTransfer",
        filters: [
          {
            Field: "productFamily",
            Value: "Data Transfer",
            Type: "TERM_MATCH",
          },
          {
            Field: "fromLocationType",
            Value: "AWS Region",
            Type: "TERM_MATCH",
          },
          { Field: "toLocationType", Value: "External", Type: "TERM_MATCH" },
          { Field: "transferType", Value: "AWS Outbound", Type: "TERM_MATCH" },
        ],
        kind: "usage_based",
        description: "per GB",
        priceUnit: "/GB",
      });
    }

    return items;
  },
};
