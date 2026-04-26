/**
 * Barrel for aws-resource-discovery. Preserves the full public surface of
 * the pre-decomposition monolith at apps/cli/src/utils/aws-resource-discovery.ts.
 */

// Re-export DiscoveryCacheKey so CLI callers can still import from this barrel
export { DiscoveryCacheKey } from "../../config/discovery-keys.js";

export type { DiscoveryOption, InstanceTypeCategory } from "./types.js";

export { clearDiscoveryCache } from "./cache.js";
export { discoverInstanceTypes } from "./ec2-instance-types.js";
export { discoverAmis, resolveAmiFromOsName, searchAmis } from "./ec2-amis.js";
export {
  discoverSubnets,
  discoverSecurityGroups,
  discoverKeyPairs,
  discoverRouteTables,
  discoverInternetGateways,
  discoverNatGateways,
} from "./ec2-network.js";
export {
  discoverRdsEngineVersions,
  discoverRdsInstanceClasses,
} from "./rds.js";
export { discoverLambdaRuntimes } from "./lambda.js";
export { discoverEfsFileSystems } from "./efs.js";
export { discoverSnsTopics } from "./sns.js";
export { discoverKmsKeys } from "./kms.js";
