/**
 * Default destroy strategies for resource types that only need
 * usesArnIdentifier and/or isSlow flags (no custom logic).
 *
 * These replace the hard-coded ARN_IDENTIFIER_TYPES and SLOW_DELETE_TYPES sets
 * from destroy-resource.ts.
 */

import type { DestroyStrategy } from "./types.js";

/** Resource types whose CloudControl primaryIdentifier is the full ARN. */
export const arnIdentifierStrategies: DestroyStrategy[] = [
  { resourceType: "AWS::SNS::Topic", usesArnIdentifier: true },
  {
    resourceType: "AWS::ElasticLoadBalancingV2::LoadBalancer",
    usesArnIdentifier: true,
    isSlow: true,
  },
  { resourceType: "AWS::SecretsManager::Secret", usesArnIdentifier: true },
  { resourceType: "AWS::ECS::Cluster", usesArnIdentifier: true },
];

/** Resource types that take longer to delete (extended polling). */
export const slowDeleteStrategies: DestroyStrategy[] = [
  { resourceType: "AWS::RDS::DBInstance", isSlow: true },
  { resourceType: "AWS::RDS::DBCluster", isSlow: true },
  { resourceType: "AWS::EC2::NatGateway", isSlow: true },
  // IGW and ELBv2 are registered with their own strategy files (igw-strategy, default above)
];
