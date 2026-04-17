/**
 * Thin re-export shim — implementation moved to @assignee/core
 * (Story 50-4 Wave 5 Pass C).
 */
export { DiscoveryCacheKey } from "@assignee/core";

export type { DiscoveryOption, InstanceTypeCategory } from "@assignee/core";

export {
  clearDiscoveryCache,
  discoverInstanceTypes,
  discoverAmis,
  resolveAmiFromOsName,
  searchAmis,
  discoverSubnets,
  discoverSecurityGroups,
  discoverKeyPairs,
  discoverRdsEngineVersions,
  discoverRdsInstanceClasses,
  discoverLambdaRuntimes,
} from "@assignee/core";
