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
          {
            value: "db.r5.large",
            label: "db.r5.large  (2 vCPU, 16 GiB) — ~$0.240/hr",
            fitHint: "Memory-optimized",
          },
          {
            value: "db.r6g.large",
            label: "db.r6g.large (2 vCPU, 16 GiB) — ~$0.208/hr",
            fitHint: "Memory-optimized, Graviton",
          },
          {
            value: "db.r6g.xlarge",
            label: "db.r6g.xlarge (4 vCPU, 32 GiB) — ~$0.416/hr",
            fitHint: "Memory-optimized, Graviton",
          },
        ],
        initialValue: "db.t3.micro",
        fetcher: "discover-rds-instance-classes",
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
      name: "EngineVersion",
      question: {
        type: "enum",
        label: "PostgreSQL version",
        hint: "Newer versions offer better performance and security. Cannot be easily downgraded.",
        options: [
          {
            value: "16",
            label: "PostgreSQL 16",
            fitHint: "Latest, best performance",
            recommended: true,
          },
          { value: "15", label: "PostgreSQL 15", fitHint: "Stable" },
        ],
        showIf: { field: "Engine", value: "postgres" },
        fetcher: "discover-rds-engine-versions",
      },
    },
    {
      name: "EngineVersion",
      question: {
        type: "enum",
        label: "MySQL version",
        hint: "Newer versions offer better performance and security. Cannot be easily downgraded.",
        options: [
          {
            value: "8.4",
            label: "MySQL 8.4",
            fitHint: "Latest",
            recommended: true,
          },
          { value: "8.0", label: "MySQL 8.0", fitHint: "Stable, widely used" },
        ],
        showIf: { field: "Engine", value: "mysql" },
        fetcher: "discover-rds-engine-versions",
      },
    },
    {
      name: "EngineVersion",
      question: {
        type: "enum",
        label: "MariaDB version",
        hint: "Newer versions offer better performance and security. Cannot be easily downgraded.",
        options: [
          {
            value: "11.4",
            label: "MariaDB 11.4",
            fitHint: "Latest",
            recommended: true,
          },
          { value: "10.11", label: "MariaDB 10.11", fitHint: "LTS" },
        ],
        showIf: { field: "Engine", value: "mariadb" },
        fetcher: "discover-rds-engine-versions",
      },
    },
    {
      name: "EngineVersion",
      question: {
        type: "enum",
        label: "Aurora MySQL version",
        hint: "Aurora MySQL is API-compatible with MySQL.",
        options: [
          {
            value: "3.07.1",
            label: "Aurora MySQL 3.07.1 (MySQL 8.0 compatible)",
            recommended: true,
          },
          { value: "3.05.2", label: "Aurora MySQL 3.05.2 (stable)" },
        ],
        showIf: { field: "Engine", value: "aurora-mysql" },
        fetcher: "discover-rds-engine-versions",
      },
    },
    {
      name: "EngineVersion",
      question: {
        type: "enum",
        label: "Aurora PostgreSQL version",
        hint: "Aurora PostgreSQL is wire-compatible with PostgreSQL.",
        options: [
          { value: "16.4", label: "Aurora PostgreSQL 16.4", recommended: true },
          { value: "15.8", label: "Aurora PostgreSQL 15.8 (stable)" },
        ],
        showIf: { field: "Engine", value: "aurora-postgresql" },
        fetcher: "discover-rds-engine-versions",
      },
    },
    {
      name: "DBName",
      question: {
        type: "string",
        label: "Initial database name",
        placeholder: "myapp",
        hint: "Name of the initial database created on launch. If omitted, no database is created and you must create one manually after provisioning. Use lowercase letters and underscores.",
      },
    },
    {
      name: "MasterUsername",
      required: true,
      question: {
        type: "string",
        label: "Master username",
        placeholder: "appuser",
        initialValue: "appuser",
        hint: "Admin username for the database. Avoid 'admin' or 'root' in production for security. Must start with a letter. Cannot be changed after creation.",
        validate: (value: unknown) =>
          typeof value === "string" && value.length > 0
            ? undefined
            : "Master username is required",
      },
    },
    {
      name: "MasterUserPassword",
      question: {
        type: "string",
        label: "Master password",
        placeholder: "Auto-generated if blank",
        initialValue: "AutoGenerated!2026x",
        hint: 'Leave blank to auto-generate a secure password stored in AWS Secrets Manager. If you provide one: min 8 chars, must include uppercase, lowercase, and numbers. Avoid /, @, " and spaces.',
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
      name: "DeletionProtection",
      question: {
        type: "boolean",
        label: "Enable deletion protection?",
        initialValue: false,
        hint: "When enabled, the database cannot be deleted via API or console until protection is removed. Strongly recommended for production to prevent accidental data loss. No cost impact.",
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
            label: "gp3 (General Purpose SSD v3) — ~$0.023/GB-month",
            fitHint: "Best price-performance",
            recommended: true,
          },
          {
            value: "gp2",
            label: "gp2 (General Purpose SSD v2) — ~$0.023/GB-month",
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
      name: "AllocatedStorage",
      question: {
        type: "enum",
        label: "Storage size (GB)",
        hint: "Minimum 20 GB for gp3/gp2. Storage cannot be decreased after creation. gp3 costs ~$0.023/GB-month. 20 GB = ~$0.46/mo, 100 GB = ~$2.30/mo.",
        options: [
          {
            value: "20",
            label: "20 GB (~$0.46/mo)",
            fitHint: "Dev/test minimum",
            recommended: true,
          },
          {
            value: "50",
            label: "50 GB (~$1.15/mo)",
            fitHint: "Small production",
          },
          {
            value: "100",
            label: "100 GB (~$2.30/mo)",
            fitHint: "Medium production",
          },
          {
            value: "200",
            label: "200 GB (~$4.60/mo)",
            fitHint: "Large production",
          },
        ],
        initialValue: "20",
      },
      toCfn: (v: unknown) => (v ? parseInt(String(v), 10) : undefined),
    },
    {
      name: "PubliclyAccessible",
      question: {
        type: "boolean",
        label: "Publicly Accessible",
        initialValue: false,
        hint: "Set to false for production databases. Place in private subnet with VPN/bastion access.",
      },
    },
    {
      name: "Tags",
      question: {
        type: "string",
        label: "Tags",
        placeholder: "env:production, team:backend",
        hint: "Comma-separated Key:Value pairs for cost tracking and organization. Example: Environment:production, Team:backend, Project:api. Tags are free and highly recommended.",
      },
      toCfn: (answer: unknown) => {
        if (typeof answer !== "string" || !answer.trim()) return undefined;
        const tags = answer
          .split(",")
          .filter((p) => p.includes(":"))
          .map((pair) => {
            const [Key, ...rest] = pair.trim().split(":");
            return { Key: Key!.trim(), Value: rest.join(":").trim() };
          });
        return tags.length > 0 ? tags : undefined;
      },
    },
  ],
  advancedFields: [
    {
      name: "DBSubnetGroupName",
      question: {
        type: "enum",
        label: "DB Subnet Group",
        fetcher: "discover-db-subnet-groups",
        hint: "Choose a DB subnet group to place the database in specific VPC subnets. Required for production databases to control network isolation.",
      },
    },
    {
      name: "VpcSecurityGroupIds",
      question: {
        type: "multi",
        label: "VPC Security Groups",
        fetcher: "discover-security-groups",
        hint: "Security groups control inbound/outbound network access to the database. At minimum, allow your application's security group on the database port.",
      },
    },
    {
      name: "Port",
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
      name: "EnableCloudwatchLogsExports",
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
      name: "PerformanceInsightsEnabled",
      question: {
        type: "boolean",
        label: "Performance Insights",
        initialValue: false,
        hint: "Provides advanced database performance monitoring with wait event analysis. Free tier includes 7 days retention for db.t3+ instances. Highly recommended for production.",
      },
    },
    {
      name: "BackupRetentionPeriod",
      question: {
        type: "string",
        label: "Backup retention period (days)",
        placeholder: "7",
        hint: "Number of days to keep automated backups (1-35). Default is 7. Longer retention increases storage cost. Set to 0 to disable backups (not recommended for production).",
        validate: (value: unknown) => {
          if (!value) return undefined;
          const n = Number(value);
          if (!Number.isInteger(n) || n < 0 || n > 35)
            return "Backup retention must be an integer between 0 and 35";
          return undefined;
        },
      },
    },
  ],
  defaults: {
    StorageType: "gp3",
    MultiAZ: false,
  },
  configHints: [
    "If the user did not provide a MasterUserPassword, OMIT it — AWS will auto-generate one via Secrets Manager",
    "If the user did not provide a DBName, OMIT it — no initial database will be created",
    "EngineVersion MUST be a valid version number for the selected Engine (e.g., '16' for postgres, '8.4' for mysql). NEVER use deprecated versions.",
    "PubliclyAccessible SHOULD be false for production. If a DBSubnetGroupName is provided, the instance is placed in that VPC subnet group.",
    "VpcSecurityGroupIds control network access — at least one security group allowing ingress on the database Port is required for connectivity.",
    "EnableCloudwatchLogsExports and PerformanceInsightsEnabled are strongly recommended for production observability. Available log types vary by engine.",
  ],
};
