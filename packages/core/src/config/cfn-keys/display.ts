/**
 * Display-name constants — human-readable labels, UI hints, and workload
 * profile keys used across wizards, pricing, and presentation code.
 *
 * Split out of `cfn-keys.ts` for SRP / file-size compliance.
 *
 * @see Story 42.10 — zero magic strings policy
 */

/**
 * Human-readable display names for RDS database engines.
 * Used in wizard labels, pricing decomposers, and pricing lookups.
 */
export const RdsEngineDisplay = {
  MYSQL: "MySQL",
  POSTGRESQL: "PostgreSQL",
  MARIADB: "MariaDB",
  ORACLE: "Oracle",
  SQL_SERVER: "SQL Server",
  AURORA_MYSQL: "Aurora MySQL",
  AURORA_POSTGRESQL: "Aurora PostgreSQL",
} as const;

/**
 * CloudWatch statistic names used in alarm configuration.
 */
export const CloudWatchStatistic = {
  AVERAGE: "Average",
  SUM: "Sum",
  MINIMUM: "Minimum",
  MAXIMUM: "Maximum",
  SAMPLE_COUNT: "SampleCount",
} as const;

/**
 * AMI OS name identifiers used in EC2 instance plugin and AMI resolution.
 */
export const AmiOs = {
  AMAZON_LINUX_2023: "amazon-linux-2023",
  WINDOWS_2022: "windows-2022",
  UBUNTU_24: "ubuntu-24.04",
  UBUNTU_22: "ubuntu-22.04",
} as const;

/**
 * RDS engine identifier strings used in wizard values and showIf conditions.
 */
export const RdsEngineId = {
  AURORA_MYSQL: "aurora-mysql",
  AURORA_POSTGRESQL: "aurora-postgresql",
} as const;

/**
 * Instance/storage size fit-hint labels used in wizard option metadata.
 */
export const SizeLabel = {
  SMALL_PRODUCTION: "Small production",
  MEDIUM_PRODUCTION: "Medium production",
  LATEST_GEN_COMPUTE: "Latest gen compute",
  BEST_PRICE_PERFORMANCE: "Best price-performance",
} as const;

/**
 * Hint string for RDS engine version fields.
 */
export const RDS_ENGINE_VERSION_HINT =
  "Newer versions offer better performance and security. Cannot be easily downgraded." as const;

/**
 * Workload profile category keys for EC2 instance type grouping.
 * Used in wizard option groups and workload classification.
 * @see Story 43 — zero magic strings policy
 */
export const WorkloadProfileKey = {
  UNKNOWN: "unknown" as const,
  BURSTABLE: "burstable" as const,
  GENERAL: "general" as const,
  COMPUTE: "compute" as const,
  MEMORY: "memory" as const,
  ACCELERATED: "accelerated" as const,
  STORAGE: "storage" as const,
  HPC: "hpc" as const,
  ARM: "arm" as const,
  OTHER: "other" as const,
} as const;
