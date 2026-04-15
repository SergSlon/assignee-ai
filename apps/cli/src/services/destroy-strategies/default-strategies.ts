/**
 * Default (flag-only) destroy strategies — types whose behavior is
 * fully captured by the `usesArnIdentifier` / `isSlow` metadata flags
 * with no custom per-type logic. These exactly mirror the hard-coded
 * `ARN_IDENTIFIED_TYPES` Set that previously lived inside the
 * CloudControl branch of `destroy-service.ts`, plus the slow-delete
 * hints the MCP server already encodes as strategies.
 *
 * Adding a new flag-only type = one line here. No core edits.
 *
 * NOTE (Wave-6 F1b): `AWS::ElasticLoadBalancingV2::LoadBalancer` was
 * promoted to a dedicated strategy file (`elbv2-loadbalancer.ts`) to
 * hook postDestroy ENI drain. It still declares
 * `usesArnIdentifier: true, isSlow: true` — the flags moved with it.
 *
 * @see Wave-6 F1a — original extraction
 * @see Wave-6 F1b — ELBv2 promoted to dedicated strategy
 */

import { RESOURCE_TYPES } from "@assignee/core";
import type { DestroyStrategy } from "./types.js";

/**
 * Resource types whose CloudControl primaryIdentifier is the full ARN
 * (TopicArn, LoadBalancerArn, Arn, etc.). Passing a bare name for
 * these causes CCAPI to return NotFound and the resource survives.
 *
 * Must match the union previously encoded in destroy-service.ts's
 * `ARN_IDENTIFIED_TYPES` — verified by tests. ELBv2 LoadBalancer is
 * NOT in this list because it lives in its own strategy file
 * (which also declares `usesArnIdentifier: true`).
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
];

/**
 * Resource types that take longer to delete and benefit from extended
 * polling. Currently advisory — F1b may promote these to effective
 * poll-cap overrides. ELBv2 LoadBalancer's `isSlow: true` lives in
 * its dedicated strategy file alongside the ENI-drain postDestroy.
 */
export const slowDeleteStrategies: DestroyStrategy[] = [
  { resourceType: RESOURCE_TYPES.RDS_DB_INSTANCE, isSlow: true },
  { resourceType: RESOURCE_TYPES.EC2_NAT_GATEWAY, isSlow: true },
];
