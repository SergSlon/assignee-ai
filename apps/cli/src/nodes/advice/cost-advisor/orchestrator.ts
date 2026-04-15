/**
 * Cost alternative advisor — suggests cheaper resource configurations.
 * Advisory prices are sourced from named constants (Story 46.1) and can
 * be enriched at runtime with live AWS Pricing API data via the
 * `services/advisory-price-enricher.ts` registry (Story 46.3). When the
 * enricher is not provided (legacy callers, unit-test paths) the function
 * synthesizes a fallback-only map internally, so every callsite gets the
 * "(estimated)" suffix without needing to know how enrichment works.
 *
 * @see Story 40.4 — Cost Alternative Advisor
 * @see Story 46.1 — Zero magic strings in advisory hints
 * @see Story 46.2 — DataSource provenance tagging
 * @see Story 46.3 — Runtime advisory price enrichment
 */
import { RESOURCE_TYPES } from "@assignee/core";
import { type EnrichedPriceMap } from "../../../constants/advisory-prices.js";
import { ec2CostHints } from "./ec2-hints.js";
import { rdsCostHints } from "./rds-hints.js";
import { s3CostHints } from "./s3-hints.js";
import { lambdaCostHints } from "./lambda-hints.js";
import { dynamodbCostHints } from "./dynamodb-hints.js";
import { sqsCostHints } from "./sqs-hints.js";
import { efsCostHints } from "./efs-hints.js";
import { eventsRuleCostHints } from "./events-rule-hints.js";
import { cloudFrontCostHints } from "./cloudfront-hints.js";
import {
  natGatewayHint,
  albHint,
  cwAlarmHint,
  ecsClusterHint,
  logsLogGroupHint,
  efsMountTargetHint,
} from "./misc-hints.js";

/**
 * Generates cost optimization hints based on the resource configuration.
 * When `enriched` is supplied (from `enrichAdvisoryPrices`) the hints
 * carry live "(live)" suffixes; otherwise every advisory price falls
 * back to its hand-coded constant tagged "(estimated)".
 */
export function costAlternatives(
  resourceType: string,
  desiredState: Record<string, unknown>,
  enriched?: EnrichedPriceMap,
): string[] {
  const hints: string[] = [];

  if (resourceType === RESOURCE_TYPES.EC2_INSTANCE) {
    ec2CostHints(desiredState, hints);
  } else if (resourceType === RESOURCE_TYPES.RDS_DB_INSTANCE) {
    rdsCostHints(desiredState, hints);
  } else if (resourceType === RESOURCE_TYPES.S3_BUCKET) {
    s3CostHints(desiredState, hints);
  } else if (resourceType === RESOURCE_TYPES.LAMBDA_FUNCTION) {
    lambdaCostHints(desiredState, hints);
  } else if (resourceType === RESOURCE_TYPES.DYNAMODB_TABLE) {
    dynamodbCostHints(desiredState, hints);
  } else if (resourceType === RESOURCE_TYPES.EC2_NAT_GATEWAY) {
    natGatewayHint(hints, enriched);
  } else if (resourceType === RESOURCE_TYPES.ELBV2_LOAD_BALANCER) {
    albHint(hints, enriched);
  } else if (resourceType === RESOURCE_TYPES.SQS_QUEUE) {
    sqsCostHints(desiredState, hints);
  } else if (resourceType === RESOURCE_TYPES.CLOUDWATCH_ALARM) {
    cwAlarmHint(hints, enriched);
  } else if (resourceType === RESOURCE_TYPES.ECS_CLUSTER) {
    ecsClusterHint(hints);
  } else if (resourceType === RESOURCE_TYPES.LOGS_LOG_GROUP) {
    logsLogGroupHint(hints, enriched);
  } else if (resourceType === RESOURCE_TYPES.EFS_FILE_SYSTEM) {
    efsCostHints(desiredState, hints, enriched);
  } else if (resourceType === RESOURCE_TYPES.EFS_MOUNT_TARGET) {
    efsMountTargetHint(hints);
  } else if (resourceType === RESOURCE_TYPES.EVENTS_RULE) {
    eventsRuleCostHints(desiredState, hints, enriched);
  } else if (resourceType === RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION) {
    cloudFrontCostHints(hints, enriched);
  }

  return hints;
}
