/**
 * Barrel for aws-resource-discovery. Preserves the full public surface of
 * the pre-decomposition monolith at apps/cli/src/utils/aws-resource-discovery.ts.
 */

// Re-export DiscoveryCacheKey from core (consumers import it from this module)
export { DiscoveryCacheKey } from "@assignee/core";

export type { DiscoveryOption, InstanceTypeCategory } from "./types.js";

export { clearDiscoveryCache } from "./cache.js";
export { discoverInstanceTypes } from "./ec2-instance-types.js";
export { discoverAmis, resolveAmiFromOsName, searchAmis } from "./ec2-amis.js";
export {
  discoverSubnets,
  discoverSecurityGroups,
  discoverKeyPairs,
} from "./ec2-network.js";
export {
  discoverRdsEngineVersions,
  discoverRdsInstanceClasses,
} from "./rds.js";
export { discoverLambdaRuntimes } from "./lambda.js";
