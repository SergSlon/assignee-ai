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
  ROUTE_TABLES: "discover-route-tables",
  INTERNET_GATEWAYS: "discover-internet-gateways",
  NAT_GATEWAYS: "discover-nat-gateways",
  EFS_FILE_SYSTEMS: "discover-efs-file-systems",
  SNS_TOPICS: "discover-sns-topics",
  KMS_KEYS: "discover-kms-keys",
} as const;
