import {
  CfnKey,
  ResourceDefault,
  AwsDefault,
  RdsEngineDisplay,
  RdsEngineId,
  SizeLabel,
} from "@/config/cfn-keys.js";
import type { ResourcePlugin } from "../../types.js";
import { engineVersionFields } from "./engine-versions.js";
import { credentialFields } from "./credentials.js";
import { storageAndAccessFields } from "./storage.js";

const coreCommonFields: ResourcePlugin["commonFields"] = [
  {
    name: CfnKey.DB_INSTANCE_CLASS,
    question: {
      type: "enum",
      label: "DB instance class",
      hint: "Determines CPU, memory, and network capacity. db.t3 = burstable (dev/test). db.m5 = general-purpose (production). Larger classes cost significantly more per hour — run `assignee cost` for live Pricing-MCP rates.",
      options: [
        {
          value: "db.t3.micro",
          label: "db.t3.micro  (2 vCPU,  1 GiB)",
          fitHint: "Dev/test",
        },
        {
          value: "db.t3.small",
          label: "db.t3.small  (2 vCPU,  2 GiB)",
          fitHint: SizeLabel.SMALL_PRODUCTION,
          recommended: true,
        },
        {
          value: "db.t3.medium",
          label: "db.t3.medium (2 vCPU,  4 GiB)",
          fitHint: SizeLabel.MEDIUM_PRODUCTION,
        },
        {
          value: "db.m5.large",
          label: "db.m5.large  (2 vCPU,  8 GiB)",
          fitHint: "High-performance production",
        },
        {
          value: "db.r5.large",
          label: "db.r5.large  (2 vCPU, 16 GiB)",
          fitHint: "Memory-optimized",
        },
        {
          value: "db.r6g.large",
          label: "db.r6g.large (2 vCPU, 16 GiB)",
          fitHint: "Memory-optimized, Graviton (cheaper than m5/r5)",
        },
        {
          value: "db.r6g.xlarge",
          label: "db.r6g.xlarge (4 vCPU, 32 GiB)",
          fitHint: "Memory-optimized, Graviton",
        },
      ],
      initialValue: AwsDefault.DB_INSTANCE_CLASS,
      fetcher: "discover-rds-instance-classes",
    },
  },
  {
    name: CfnKey.ENGINE,
    question: {
      type: "enum",
      label: "Database engine",
      hint: "Database engine and version. PostgreSQL is the most feature-rich open-source option. Aurora variants offer auto-scaling but cost more. Engine cannot be changed after creation.",
      options: [
        {
          value: AwsDefault.RDS_ENGINE_MYSQL,
          label: RdsEngineDisplay.MYSQL,
          fitHint: "Widely supported",
        },
        {
          value: AwsDefault.RDS_ENGINE_POSTGRES,
          label: RdsEngineDisplay.POSTGRESQL,
          fitHint: "Most popular, advanced features",
          recommended: true,
        },
        {
          value: "mariadb",
          label: RdsEngineDisplay.MARIADB,
          fitHint: "MySQL-compatible",
        },
        {
          value: RdsEngineId.AURORA_MYSQL,
          label: RdsEngineDisplay.AURORA_MYSQL,
          fitHint: "AWS-native, auto-scaling",
        },
        {
          value: RdsEngineId.AURORA_POSTGRESQL,
          label: RdsEngineDisplay.AURORA_POSTGRESQL,
          fitHint: "AWS-native, auto-scaling",
        },
      ],
      initialValue: ResourceDefault.RDS_ENGINE_POSTGRES,
    },
  },
];

export const commonFields: ResourcePlugin["commonFields"] = [
  ...coreCommonFields,
  ...engineVersionFields,
  ...credentialFields,
  ...storageAndAccessFields,
];

export const advancedFields: ResourcePlugin["advancedFields"] = [
  {
    name: CfnKey.DB_SUBNET_GROUP_NAME,
    question: {
      type: "enum",
      label: "DB Subnet Group",
      fetcher: "discover-db-subnet-groups",
      hint: "Choose a DB subnet group to place the database in specific VPC subnets. Required for production databases to control network isolation.",
    },
  },
  {
    name: CfnKey.VPC_SECURITY_GROUP_IDS,
    question: {
      type: "multi",
      label: "VPC Security Groups",
      fetcher: "discover-security-groups",
      hint: "Security groups control inbound/outbound network access to the database. At minimum, allow your application's security group on the database port.",
    },
  },
  {
    name: CfnKey.PORT,
    question: {
      type: "string",
      label: "Database Port",
      placeholder: "5432 (postgres) / 3306 (mysql)",
      hint: "Default ports: PostgreSQL 5432, MySQL/MariaDB 3306, Oracle 1521, SQL Server 1433. Non-standard ports add security-by-obscurity but require firewall rule updates.",
      validate: (value: unknown) => {
        if (!value) return undefined;
        const n = Number(value);
        if (!Number.isFinite(n) || !Number.isInteger(n) || n < 1 || n > 65535)
          return "Port must be a number between 1 and 65535";
        return undefined;
      },
    },
    toCfn: (v: unknown) => (v ? parseInt(String(v), 10) : undefined),
  },
  {
    name: CfnKey.ENABLE_CW_LOGS_EXPORTS,
    question: {
      type: "multi",
      label: "CloudWatch Logs Exports",
      hint: "Export database logs to CloudWatch for monitoring, alerting, and troubleshooting. Error + slow query logs are recommended for production.",
      options: [
        { value: "error", label: "Error log" },
        { value: "general", label: "General log" },
        { value: "slowquery", label: "Slow query log" },
        { value: "audit", label: "Audit log" },
      ],
    },
    toCfn: (v: unknown) => {
      if (!Array.isArray(v) || v.length === 0) return undefined;
      return v.map(String);
    },
  },
  {
    name: CfnKey.PERFORMANCE_INSIGHTS,
    question: {
      type: "boolean",
      label: "Performance Insights",
      initialValue: false,
      hint: "Provides advanced database performance monitoring with wait event analysis. Free tier includes 7 days retention for db.t3+ instances. Highly recommended for production.",
    },
  },
  {
    name: CfnKey.BACKUP_RETENTION_PERIOD,
    question: {
      type: "string",
      label: "Backup retention period (days)",
      placeholder: "7",
      initialValue: "7",
      hint: "Number of days to keep automated backups (1-35). Default is 7. Longer retention increases storage cost. Set to 0 to disable backups (not recommended for production).",
      validate: (value: unknown) => {
        if (!value) return undefined;
        const n = Number(value);
        if (!Number.isInteger(n) || n < 0 || n > 35)
          return "Backup retention must be an integer between 0 and 35";
        return undefined;
      },
    },
    toCfn: (v: unknown) => {
      const n = Number(v);
      return isNaN(n) ? undefined : n;
    },
  },
  {
    name: CfnKey.STORAGE_ENCRYPTED,
    question: {
      type: "boolean" as const,
      label: "Encrypt storage at rest?",
      initialValue: true,
      hint: "Encrypts the database storage using AWS KMS. Strongly recommended. No significant performance impact. Uses the default AWS-managed key unless a custom KMS key is specified.",
    },
  },
];
