/**
 * Flag-only destroy strategies — types whose behavior is fully
 * captured by `usesArnIdentifier` / `isSlow` metadata with no custom
 * per-type logic. Both `apps/cli` and `apps/mcp-server` register these
 * via the shared `DestroyStrategyRegistry`.
 *
 * This is the union of the prior per-app lists:
 *
 * - CLI contributed: SNS_SUBSCRIPTION, EVENTS_RULE (ARN identifier),
 *   plus promoted ELBV2_LOAD_BALANCER to a dedicated CLI strategy
 *   (ENI drain postDestroy). CLI re-registers its dedicated strategy
 *   *after* these defaults, so the entry below is a safe baseline.
 * - MCP contributed: ELBV2_LOAD_BALANCER as a flag-only arn-identifier
 *   default (no ENI drain in MCP).
 *
 * MCP previously declared RDS::DBCluster as slow; the project does
 * not provision DB clusters, so bulk-destroy will simply fall through
 * to the default polling window if a user ever targets one.
 *
 * @see Story 49.1 — extract shared destroy-strategies to @assignee/core
 */

import { RESOURCE_TYPES } from "../config/resource-types/named.js";
import type { DestroyStrategy } from "./types.js";

/**
 * Resource types whose CloudControl primaryIdentifier is the full
 * ARN (TopicArn, LoadBalancerArn, Arn, etc.). Passing a bare name for
 * these causes CCAPI to return NotFound and the resource survives.
 */
export const arnIdentifierStrategies: DestroyStrategy[] = [
  { resourceType: RESOURCE_TYPES.SNS_TOPIC, usesArnIdentifier: true },
  { resourceType: RESOURCE_TYPES.SNS_SUBSCRIPTION, usesArnIdentifier: true },
  {
    resourceType: RESOURCE_TYPES.SECRETSMANAGER_SECRET,
    usesArnIdentifier: true,
  },
  { resourceType: RESOURCE_TYPES.ECS_CLUSTER, usesArnIdentifier: true },
  { resourceType: RESOURCE_TYPES.EVENTS_RULE, usesArnIdentifier: true },
  {
    resourceType: RESOURCE_TYPES.ELBV2_LOAD_BALANCER,
    usesArnIdentifier: true,
    isSlow: true,
  },
];

/**
 * Resource types that take longer to delete and benefit from extended
 * polling. Currently advisory — callers with a poll loop consult
 * `DestroyStrategy.isSlow` to extend their cap.
 */
export const slowDeleteStrategies: DestroyStrategy[] = [
  { resourceType: RESOURCE_TYPES.RDS_DB_INSTANCE, isSlow: true },
  { resourceType: RESOURCE_TYPES.EC2_NAT_GATEWAY, isSlow: true },
];
