/**
 * AWS resource discovery for dynamic option elicitation.
 * Fetches real VPCs, subnets, security groups, key pairs, and AMIs
 * from the user's AWS account using the READER credential set.
 *
 * Each function has a 6-second timeout and returns [] on failure.
 * Results are cached per-session to avoid redundant API calls.
 *
 * @see Story 7.11
 *
 * This file is a thin facade over the decomposed module at
 * ./aws-resource-discovery/. Each AWS service's discoverers live in
 * their own SRP-focused file (ec2-instance-types, ec2-amis, ec2-network,
 * rds, lambda). Clients, cache, and family-categorization are shared.
 */

export { DiscoveryCacheKey } from "../config/discovery-keys.js";

export type {
  DiscoveryOption,
  InstanceTypeCategory,
} from "./aws-resource-discovery/index.js";

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
} from "./aws-resource-discovery/index.js";
