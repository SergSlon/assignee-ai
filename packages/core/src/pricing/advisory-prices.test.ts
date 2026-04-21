/**
 * Tests for `packages/core/src/pricing/advisory-prices.ts`.
 *
 * Story 92.1.e adds per-resource-type relevance gating. Every supported
 * resource type is enumerated below; the test verifies that only types
 * whose cost-advisor branch actually reads enriched prices surface a
 * non-empty `AdvisoryPriceId` set. Closes findings A-05, B-19, C-08,
 * C-21, D-17 — all the noisy `pricing_unavailable advisoryPriceId=alb-
 * monthly` warnings that fired on every non-ALB plan.
 */

import { describe, it, expect } from "vitest";
import { RESOURCE_TYPES } from "../config/resource-types.js";
import {
  AdvisoryPriceId,
  getRelevantAdvisoryPriceIds,
  resourceTypeNeedsAdvisoryPrices,
} from "./advisory-prices.js";

describe("getRelevantAdvisoryPriceIds", () => {
  it("returns NAT_GATEWAY_MONTHLY for EC2_NAT_GATEWAY", () => {
    const ids = getRelevantAdvisoryPriceIds(RESOURCE_TYPES.EC2_NAT_GATEWAY);
    expect(ids.has(AdvisoryPriceId.NAT_GATEWAY_MONTHLY)).toBe(true);
    expect(ids.size).toBe(1);
  });

  it("returns ALB_MONTHLY for ELBV2_LOAD_BALANCER", () => {
    const ids = getRelevantAdvisoryPriceIds(RESOURCE_TYPES.ELBV2_LOAD_BALANCER);
    expect(ids.has(AdvisoryPriceId.ALB_MONTHLY)).toBe(true);
    expect(ids.size).toBe(1);
  });

  it("returns CW_ALARM_PER_MONTH for CLOUDWATCH_ALARM", () => {
    const ids = getRelevantAdvisoryPriceIds(RESOURCE_TYPES.CLOUDWATCH_ALARM);
    expect(ids.has(AdvisoryPriceId.CW_ALARM_PER_MONTH)).toBe(true);
    expect(ids.size).toBe(1);
  });

  it("returns CW_LOGS_INGESTION_PER_GB for LOGS_LOG_GROUP", () => {
    const ids = getRelevantAdvisoryPriceIds(RESOURCE_TYPES.LOGS_LOG_GROUP);
    expect(ids.has(AdvisoryPriceId.CW_LOGS_INGESTION_PER_GB)).toBe(true);
    expect(ids.size).toBe(1);
  });

  it("returns EFS_PROVISIONED_PER_MIBS_MONTH for EFS_FILE_SYSTEM", () => {
    const ids = getRelevantAdvisoryPriceIds(RESOURCE_TYPES.EFS_FILE_SYSTEM);
    expect(ids.has(AdvisoryPriceId.EFS_PROVISIONED_PER_MIBS_MONTH)).toBe(true);
    expect(ids.size).toBe(1);
  });

  it("returns EVENTBRIDGE_CUSTOM_PER_MILLION for EVENTS_RULE", () => {
    const ids = getRelevantAdvisoryPriceIds(RESOURCE_TYPES.EVENTS_RULE);
    expect(ids.has(AdvisoryPriceId.EVENTBRIDGE_CUSTOM_PER_MILLION)).toBe(true);
    expect(ids.size).toBe(1);
  });

  it("returns CF_INVALIDATION_EACH for CLOUDFRONT_DISTRIBUTION", () => {
    const ids = getRelevantAdvisoryPriceIds(
      RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION,
    );
    expect(ids.has(AdvisoryPriceId.CF_INVALIDATION_EACH)).toBe(true);
    expect(ids.size).toBe(1);
  });

  // ── Per-type gating table: types that must NOT trigger any fetch ─────
  //
  // The brief enumerates S3/Lambda/DDB/SNS/SQS/EC2/Logs/IAM/SSM/
  // EventBridge/SNS-sub as the resource types that historically spammed
  // `pricing_unavailable advisoryPriceId=alb-monthly` warnings. Each
  // must return an empty set so the advice-generator skips
  // `enrichAdvisoryPrices` entirely.
  it.each([
    ["S3_BUCKET", RESOURCE_TYPES.S3_BUCKET],
    ["LAMBDA_FUNCTION", RESOURCE_TYPES.LAMBDA_FUNCTION],
    ["DYNAMODB_TABLE", RESOURCE_TYPES.DYNAMODB_TABLE],
    ["SNS_TOPIC", RESOURCE_TYPES.SNS_TOPIC],
    ["SQS_QUEUE", RESOURCE_TYPES.SQS_QUEUE],
    ["EC2_INSTANCE", RESOURCE_TYPES.EC2_INSTANCE],
    ["IAM_ROLE", RESOURCE_TYPES.IAM_ROLE],
    ["SSM_PARAMETER", RESOURCE_TYPES.SSM_PARAMETER],
    ["RDS_DB_INSTANCE", RESOURCE_TYPES.RDS_DB_INSTANCE],
    ["SNS_SUBSCRIPTION", RESOURCE_TYPES.SNS_SUBSCRIPTION],
    ["EVENTS_EVENT_BUS", RESOURCE_TYPES.EVENTS_EVENT_BUS],
    ["EC2_VPC", RESOURCE_TYPES.EC2_VPC],
    ["EC2_SUBNET", RESOURCE_TYPES.EC2_SUBNET],
    ["EC2_SECURITY_GROUP", RESOURCE_TYPES.EC2_SECURITY_GROUP],
    ["EC2_INTERNET_GATEWAY", RESOURCE_TYPES.EC2_INTERNET_GATEWAY],
    ["EC2_ROUTE_TABLE", RESOURCE_TYPES.EC2_ROUTE_TABLE],
    ["EC2_ROUTE", RESOURCE_TYPES.EC2_ROUTE],
    ["ECS_CLUSTER", RESOURCE_TYPES.ECS_CLUSTER],
    ["ECR_REPOSITORY", RESOURCE_TYPES.ECR_REPOSITORY],
    ["APIGATEWAYV2_API", RESOURCE_TYPES.APIGATEWAYV2_API],
    ["SECRETSMANAGER_SECRET", RESOURCE_TYPES.SECRETSMANAGER_SECRET],
    ["KMS_KEY", RESOURCE_TYPES.KMS_KEY],
    ["EFS_MOUNT_TARGET", RESOURCE_TYPES.EFS_MOUNT_TARGET],
    ["EVENTS_CONNECTION", RESOURCE_TYPES.EVENTS_CONNECTION],
    ["EVENTS_API_DESTINATION", RESOURCE_TYPES.EVENTS_API_DESTINATION],
    [
      "CLOUDFRONT_ORIGIN_ACCESS_CONTROL",
      RESOURCE_TYPES.CLOUDFRONT_ORIGIN_ACCESS_CONTROL,
    ],
    ["S3_BUCKET_POLICY", RESOURCE_TYPES.S3_BUCKET_POLICY],
    ["RDS_DB_SUBNET_GROUP", RESOURCE_TYPES.RDS_DB_SUBNET_GROUP],
    ["EC2_VPC_GATEWAY_ATTACHMENT", RESOURCE_TYPES.EC2_VPC_GATEWAY_ATTACHMENT],
    [
      "EC2_SUBNET_ROUTE_TABLE_ASSOCIATION",
      RESOURCE_TYPES.EC2_SUBNET_ROUTE_TABLE_ASSOCIATION,
    ],
  ])(
    "%s returns empty set — must NOT trigger advisory-price fetch",
    (_name, resourceType) => {
      const ids = getRelevantAdvisoryPriceIds(resourceType);
      expect(ids.size).toBe(0);
      expect(resourceTypeNeedsAdvisoryPrices(resourceType)).toBe(false);
    },
  );

  it("returns empty set for undefined resource type", () => {
    expect(getRelevantAdvisoryPriceIds(undefined).size).toBe(0);
    expect(resourceTypeNeedsAdvisoryPrices(undefined)).toBe(false);
  });

  it("returns empty set for unknown resource type", () => {
    expect(getRelevantAdvisoryPriceIds("AWS::SomeFuture::Resource").size).toBe(
      0,
    );
    expect(resourceTypeNeedsAdvisoryPrices("AWS::SomeFuture::Resource")).toBe(
      false,
    );
  });

  // ── Symmetric positive checks for the gated types ────────────────────
  it.each([
    [RESOURCE_TYPES.EC2_NAT_GATEWAY],
    [RESOURCE_TYPES.ELBV2_LOAD_BALANCER],
    [RESOURCE_TYPES.CLOUDWATCH_ALARM],
    [RESOURCE_TYPES.LOGS_LOG_GROUP],
    [RESOURCE_TYPES.EFS_FILE_SYSTEM],
    [RESOURCE_TYPES.EVENTS_RULE],
    [RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION],
  ])("%s DOES need advisory prices (positive check)", (resourceType) => {
    expect(resourceTypeNeedsAdvisoryPrices(resourceType)).toBe(true);
  });
});

describe("AdvisoryPriceId enum invariants", () => {
  it("is unchanged from the original 7 IDs (contract with downstream consumers)", () => {
    // The story invariant says `AdvisoryPriceId` enum untouched. Pin
    // membership so an accidental addition/removal fails here.
    const members = Object.values(AdvisoryPriceId).sort();
    expect(members).toEqual(
      [
        "alb-monthly",
        "cf-invalidation-each",
        "cw-alarm-per-month",
        "cw-logs-ingestion-per-gb",
        "efs-provisioned-per-mibs-month",
        "eventbridge-custom-per-million",
        "nat-gateway-monthly",
      ].sort(),
    );
  });
});
