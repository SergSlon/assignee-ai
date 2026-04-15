import { RESOURCE_TYPES } from "../../config/resource-types.js";
import {
  CfnKey,
  ResourceDefault,
  AwsDefault,
  RdsEngineDisplay,
  RdsEngineId,
  SizeLabel,
  RDS_ENGINE_VERSION_HINT,
} from "../../config/cfn-keys.js";
import type { ResourcePlugin, CfnOutput } from "../types.js";
import { TAGS_VALIDATE, TAGS_HINT } from "../shared-fields.js";
import { FieldLabel } from "../field-labels.js";

/**
 * ResourcePlugin for AWS::RDS::DBInstance.
 */
export const rdsDbInstancePlugin: ResourcePlugin = {
  resourceType: RESOURCE_TYPES.RDS_DB_INSTANCE,
  commonFields: [
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
    {
      name: CfnKey.ENGINE_VERSION,
      question: {
        type: "enum",
        label: "PostgreSQL version",
        hint: RDS_ENGINE_VERSION_HINT,
        options: [
          {
            value: "16",
            label: "PostgreSQL 16",
            fitHint: "Latest, best performance",
            recommended: true,
          },
          { value: "15", label: "PostgreSQL 15", fitHint: "Stable" },
        ],
        showIf: {
          field: CfnKey.ENGINE,
          value: ResourceDefault.RDS_ENGINE_POSTGRES,
        },
        fetcher: "discover-rds-engine-versions",
      },
    },
    {
      name: CfnKey.ENGINE_VERSION,
      question: {
        type: "enum",
        label: "MySQL version",
        hint: RDS_ENGINE_VERSION_HINT,
        options: [
          {
            value: "8.4",
            label: "MySQL 8.4",
            fitHint: "Latest",
            recommended: true,
          },
          { value: "8.0", label: "MySQL 8.0", fitHint: "Stable, widely used" },
        ],
        showIf: { field: CfnKey.ENGINE, value: AwsDefault.RDS_ENGINE_MYSQL },
        fetcher: "discover-rds-engine-versions",
      },
    },
    {
      name: CfnKey.ENGINE_VERSION,
      question: {
        type: "enum",
        label: "MariaDB version",
        hint: RDS_ENGINE_VERSION_HINT,
        options: [
          {
            value: "11.4",
            label: "MariaDB 11.4",
            fitHint: "Latest",
            recommended: true,
          },
          { value: "10.11", label: "MariaDB 10.11", fitHint: "LTS" },
        ],
        showIf: { field: CfnKey.ENGINE, value: "mariadb" },
        fetcher: "discover-rds-engine-versions",
      },
    },
    {
      name: CfnKey.ENGINE_VERSION,
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
        showIf: { field: CfnKey.ENGINE, value: RdsEngineId.AURORA_MYSQL },
        fetcher: "discover-rds-engine-versions",
      },
    },
    {
      name: CfnKey.ENGINE_VERSION,
      question: {
        type: "enum",
        label: "Aurora PostgreSQL version",
        hint: "Aurora PostgreSQL is wire-compatible with PostgreSQL.",
        options: [
          { value: "16.4", label: "Aurora PostgreSQL 16.4", recommended: true },
          { value: "15.8", label: "Aurora PostgreSQL 15.8 (stable)" },
        ],
        showIf: { field: CfnKey.ENGINE, value: RdsEngineId.AURORA_POSTGRESQL },
        fetcher: "discover-rds-engine-versions",
      },
    },
    {
      name: CfnKey.DB_NAME,
      question: {
        type: "string",
        label: "Initial database name",
        placeholder: "myapp",
        hint: "Name of the initial database created on launch. If omitted, no database is created and you must create one manually after provisioning. Use lowercase letters and underscores.",
        validate: (value: unknown) => {
          if (!value) return undefined; // optional field
          const s = String(value);
          if (s.length < 1 || s.length > 64)
            return "Database name must be between 1 and 64 characters";
          if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(s))
            return "Database name must start with a letter and contain only letters, numbers, and underscores";
          return undefined;
        },
      },
    },
    {
      name: CfnKey.MASTER_USERNAME,
      required: true,
      question: {
        type: "string",
        label: "Master username",
        placeholder: "appuser",
        initialValue: "appuser",
        hint: "Admin username for the database. Avoid 'admin' or 'root' in production for security. Must start with a letter. Cannot be changed after creation.",
        validate: (value: unknown) => {
          if (typeof value !== "string" || value.length === 0)
            return "Master username is required";
          if (value.length > 41)
            return "Master username must be at most 41 characters";
          if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(value))
            return "Must start with a letter and contain only letters, numbers, and underscores";
          return undefined;
        },
      },
    },
    {
      name: CfnKey.MASTER_USER_PASSWORD,
      question: {
        type: "string",
        label: "Master password",
        placeholder: "Auto-generated if blank",
        hint: 'Set a strong password (min 8 chars, uppercase + lowercase + numbers). Leave blank to auto-generate a secure password stored in AWS Secrets Manager. Avoid /, @, " and spaces.',
        validate: (value: unknown) => {
          if (!value) return undefined; // blank = auto-generate
          const s = String(value);
          if (s.length < 8) return "Password must be at least 8 characters";
          if (s.length > 128) return "Password must be 128 characters or less";
          if (/[/@" ]/.test(s))
            return 'Password must not contain /, @, " (double quote), or spaces';
          return undefined;
        },
      },
    },
    {
      name: CfnKey.MULTI_AZ,
      question: {
        type: "boolean",
        label: "Enable Multi-AZ deployment?",
        initialValue: true,
        hint: "Doubles cost. Provides high availability with automatic failover. Best for production.",
      },
    },
    {
      name: CfnKey.DELETION_PROTECTION,
      question: {
        type: "boolean",
        label: "Enable deletion protection?",
        initialValue: true,
        hint: "When enabled, the database cannot be deleted via API or console until protection is removed. Strongly recommended for production to prevent accidental data loss. No cost impact.",
      },
    },
    {
      name: CfnKey.STORAGE_TYPE,
      question: {
        type: "enum",
        label: "Storage type",
        hint: "gp3 is the best price-performance for most workloads. io1 is for high-IOPS needs (thousands of transactions/sec). gp2 is legacy -- prefer gp3 for new databases. Run `assignee cost` for live Pricing-MCP rates.",
        options: [
          {
            value: AwsDefault.EBS_VOLUME_TYPE,
            label: "gp3 (General Purpose SSD v3)",
            fitHint: SizeLabel.BEST_PRICE_PERFORMANCE,
            recommended: true,
          },
          {
            value: "gp2",
            label: "gp2 (General Purpose SSD v2)",
            fitHint: "Legacy, prefer gp3",
          },
          {
            value: "io1",
            label: "io1 (Provisioned IOPS SSD)",
            fitHint: "High-IOPS workloads (per-IOPS charges apply)",
          },
        ],
        initialValue: ResourceDefault.EBS_VOLUME_TYPE,
      },
    },
    {
      name: CfnKey.ALLOCATED_STORAGE,
      question: {
        type: "enum",
        label: "Storage size (GB)",
        hint: "Minimum 20 GB for gp3/gp2. Storage cannot be decreased after creation. Run `assignee cost` for live per-GB-month rates from the Pricing MCP.",
        options: [
          {
            value: "20",
            label: "20 GB",
            fitHint: "Dev/test minimum",
            recommended: true,
          },
          {
            value: "50",
            label: "50 GB",
            fitHint: SizeLabel.SMALL_PRODUCTION,
          },
          {
            value: "100",
            label: "100 GB",
            fitHint: SizeLabel.MEDIUM_PRODUCTION,
          },
          {
            value: "200",
            label: "200 GB",
            fitHint: "Large production",
          },
        ],
        initialValue: "20",
      },
      toCfn: (v: unknown) => (v ? parseInt(String(v), 10) : undefined),
    },
    {
      name: CfnKey.PUBLICLY_ACCESSIBLE,
      question: {
        type: "boolean",
        label: "Publicly Accessible",
        initialValue: false,
        hint: "Set to false for production databases. Place in private subnet with VPN/bastion access.",
      },
    },
    {
      name: CfnKey.TAGS,
      question: {
        type: "string",
        label: FieldLabel.TAGS,
        placeholder: "env:production, team:backend",
        hint: TAGS_HINT,
        validate: TAGS_VALIDATE,
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
  ],
  defaults: {
    [CfnKey.STORAGE_TYPE]: ResourceDefault.EBS_VOLUME_TYPE,
    [CfnKey.MULTI_AZ]: false,
    [CfnKey.STORAGE_ENCRYPTED]: true,
  },
  companionResources(desiredState: Record<string, unknown>): CfnOutput[] {
    // Auto-create a SecurityGroup for DB access when none specified
    const vpcSgIds = desiredState[CfnKey.VPC_SECURITY_GROUP_IDS];
    if (Array.isArray(vpcSgIds) && vpcSgIds.length > 0) return [];

    const engine = (desiredState[CfnKey.ENGINE] as string) ?? "postgres";
    const port =
      engine.includes("mysql") ||
      engine.includes("mariadb") ||
      engine.includes("aurora-mysql")
        ? 3306
        : 5432;
    const dbClass =
      (desiredState[CfnKey.DB_INSTANCE_CLASS] as string) ?? "db-instance";
    const sanitized = dbClass.replace(/[^a-zA-Z0-9]/g, "-");

    return [
      {
        logicalId: `${sanitized}SecurityGroup`,
        type: RESOURCE_TYPES.EC2_SECURITY_GROUP,
        properties: {
          [CfnKey.GROUP_DESCRIPTION]: `Security group for RDS ${engine} (port ${port})`,
          SecurityGroupIngress: [
            {
              IpProtocol: "tcp",
              FromPort: port,
              ToPort: port,
              CidrIp: "10.0.0.0/8",
              Description: `${engine} access from private network`,
            },
          ],
          SecurityGroupEgress: [
            {
              IpProtocol: "-1",
              CidrIp: "0.0.0.0/0",
              Description: "Allow all outbound",
            },
          ],
        },
      },
    ];
  },
  configHints: [
    "If the user did not provide a MasterUserPassword, OMIT it — AWS will auto-generate one via Secrets Manager",
    "If the user did not provide a DBName, OMIT it — no initial database will be created",
    "EngineVersion MUST be a valid version number for the selected Engine (e.g., '16' for postgres, '8.4' for mysql). NEVER use deprecated versions.",
    "PubliclyAccessible SHOULD be false for production. If a DBSubnetGroupName is provided, the instance is placed in that VPC subnet group.",
    "VPCSecurityGroups control network access — at least one security group allowing ingress on the database Port is required for connectivity.",
    "EnableCloudwatchLogsExports and PerformanceInsightsEnabled are strongly recommended for production observability. Available log types vary by engine.",
    "StorageEncrypted SHOULD always be true. Encryption at rest is an AWS security best practice with no significant performance impact.",
  ],
};
