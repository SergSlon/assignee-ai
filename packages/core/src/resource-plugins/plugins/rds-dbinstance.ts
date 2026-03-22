import { RESOURCE_TYPES } from "../../config/resource-types.js";
import type { ResourcePlugin } from "../types.js";

/**
 * ResourcePlugin for AWS::RDS::DBInstance.
 */
export const rdsDbInstancePlugin: ResourcePlugin = {
  resourceType: RESOURCE_TYPES.RDS_DB_INSTANCE,
  commonFields: [
    {
      name: "DBInstanceClass",
      question: {
        type: "enum",
        label: "DB instance class",
        hint: "Determines CPU, memory, and network capacity. db.t3 = burstable (dev/test). db.m5 = general-purpose (production). Larger classes cost significantly more per hour.",
        options: [
          {
            value: "db.t3.micro",
            label: "db.t3.micro  (2 vCPU,  1 GiB) — ~$0.017/hr",
            fitHint: "Dev/test",
          },
          {
            value: "db.t3.small",
            label: "db.t3.small  (2 vCPU,  2 GiB) — ~$0.034/hr",
            fitHint: "Small production",
            recommended: true,
          },
          {
            value: "db.t3.medium",
            label: "db.t3.medium (2 vCPU,  4 GiB) — ~$0.068/hr",
            fitHint: "Medium production",
          },
          {
            value: "db.m5.large",
            label: "db.m5.large  (2 vCPU,  8 GiB) — ~$0.171/hr",
            fitHint: "High-performance production",
          },
        ],
        initialValue: "db.t3.micro",
      },
    },
    {
      name: "Engine",
      question: {
        type: "enum",
        label: "Database engine",
        hint: "Database engine and version. PostgreSQL is the most feature-rich open-source option. Aurora variants offer auto-scaling but cost more. Engine cannot be changed after creation.",
        options: [
          { value: "mysql", label: "MySQL", fitHint: "Widely supported" },
          {
            value: "postgres",
            label: "PostgreSQL",
            fitHint: "Most popular, advanced features",
            recommended: true,
          },
          { value: "mariadb", label: "MariaDB", fitHint: "MySQL-compatible" },
          {
            value: "aurora-mysql",
            label: "Aurora MySQL",
            fitHint: "AWS-native, auto-scaling",
          },
          {
            value: "aurora-postgresql",
            label: "Aurora PostgreSQL",
            fitHint: "AWS-native, auto-scaling",
          },
        ],
        initialValue: "postgres",
      },
    },
    {
      name: "MasterUsername",
      question: {
        type: "string",
        label: "Master username",
        placeholder: "admin",
        hint: "Admin username for the database. Avoid 'admin' or 'root' in production for security. Must start with a letter. Cannot be changed after creation.",
        validate: (value: unknown) =>
          typeof value === "string" && value.length > 0
            ? undefined
            : "Master username is required",
      },
    },
    {
      name: "MultiAZ",
      question: {
        type: "boolean",
        label: "Enable Multi-AZ deployment?",
        initialValue: false,
        hint: "Doubles cost. Provides high availability with automatic failover. Best for production.",
      },
    },
    {
      name: "StorageType",
      question: {
        type: "enum",
        label: "Storage type",
        hint: "gp3 is the best price-performance for most workloads. io1 is for high-IOPS needs (thousands of transactions/sec). gp2 is legacy -- prefer gp3 for new databases.",
        options: [
          {
            value: "gp3",
            label: "gp3 (General Purpose SSD v3) — ~$0.115/GB-month",
            fitHint: "Best price-performance",
            recommended: true,
          },
          {
            value: "gp2",
            label: "gp2 (General Purpose SSD v2) — ~$0.115/GB-month",
            fitHint: "Legacy, prefer gp3",
          },
          {
            value: "io1",
            label:
              "io1 (Provisioned IOPS SSD)   — ~$0.125/GB-month + $0.10/IOPS",
            fitHint: "High-IOPS workloads",
          },
        ],
        initialValue: "gp3",
      },
    },
    {
      name: "Tags",
      question: {
        type: "multi",
        label: "Tags",
        hint: "Key-value pairs for cost tracking and organization. Common tags: Environment (dev/staging/prod), Team, Project. Tags are free and highly recommended.",
        options: [],
      },
    },
  ],
  advancedFields: [
    {
      name: "BackupRetentionPeriod",
      question: {
        type: "string",
        label: "Backup retention period (days)",
        placeholder: "7",
        hint: "Number of days to keep automated backups (1-35). Default is 7. Longer retention increases storage cost. Set to 0 to disable backups (not recommended for production).",
      },
    },
    {
      name: "DeletionProtection",
      question: {
        type: "boolean",
        label: "Enable deletion protection?",
        initialValue: false,
        hint: "When enabled, the database cannot be deleted via API or console until protection is removed. Strongly recommended for production to prevent accidental data loss. No cost impact.",
      },
    },
  ],
  defaults: {
    StorageType: "gp3",
    MultiAZ: false,
  },
};
