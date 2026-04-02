/**
 * Named constants for discovery cache keys.
 * Used by core plugins and CLI discovery layer.
 *
 * @see Story 42.10 — zero magic strings policy
 */
export const DiscoveryCacheKey = {
  SUBNETS: "discover-subnets",
  SECURITY_GROUPS: "discover-security-groups",
  KEY_PAIRS: "discover-key-pairs",
  RDS_ENGINE_VERSIONS: "discover-rds-engine-versions",
  RDS_INSTANCE_CLASSES: "discover-rds-instance-classes",
  VPCS: "discover-vpcs",
  AMIS: "discover-amis",
  LAMBDA_RUNTIMES: "discover-lambda-runtimes",
} as const;
