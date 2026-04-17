/**
 * Friendly key names for plan box rendering (Story 18.11).
 *
 * Keyed by raw CFN property name → human label. When a property name is
 * ambiguous across resource types (e.g. "Type"), see FRIENDLY_NAMES_BY_TYPE
 * in ./friendly-names-by-type.ts for per-resource overrides.
 */
import { CfnKey } from "../../config/cfn-keys/keys.js";

export const FRIENDLY_NAMES: Record<string, string> = {
  [CfnKey.INSTANCE_TYPE]: "Instance Type",
  [CfnKey.IMAGE_ID]: "AMI",
  [CfnKey.KEY_NAME]: "Key Pair",
  [CfnKey.SUBNET_ID]: "Subnet",
  [CfnKey.SECURITY_GROUP_IDS]: "Security Groups",
  [CfnKey.BUCKET_NAME]: "Bucket Name",
  [CfnKey.BUCKET_ENCRYPTION]: "Encryption",
  [CfnKey.PUBLIC_ACCESS_BLOCK]: "Block Public Access",
  [CfnKey.VERSIONING_CONFIGURATION]: "Versioning",
  [CfnKey.DB_INSTANCE_CLASS]: "DB Instance Class",
  [CfnKey.ENGINE]: "Engine",
  [CfnKey.MASTER_USERNAME]: "Master Username",
  [CfnKey.MASTER_USER_PASSWORD]: "Master Password",
  [CfnKey.ALLOCATED_STORAGE]: "Storage (GB)",
  [CfnKey.MULTI_AZ]: "Multi-AZ",
  [CfnKey.STORAGE_TYPE]: "Storage Type",
  [CfnKey.FUNCTION_NAME]: "Function Name",
  [CfnKey.RUNTIME]: "Runtime",
  [CfnKey.HANDLER]: "Handler",
  [CfnKey.MEMORY_SIZE]: "Memory (MB)",
  [CfnKey.TIMEOUT]: "Timeout (s)",
  [CfnKey.ROLE]: "Execution Role",
  [CfnKey.TAGS]: "Tags",
  [CfnKey.DB_NAME]: "Database Name",
  [CfnKey.ENGINE_VERSION]: "Engine Version",
  [CfnKey.DELETION_PROTECTION]: "Deletion Protection",
  [CfnKey.BACKUP_RETENTION_PERIOD]: "Backup Retention (days)",
  [CfnKey.DESCRIPTION]: "Description",
  [CfnKey.RESERVED_CONCURRENT_EXECUTIONS]: "Reserved Concurrency",
  [CfnKey.ENVIRONMENT]: "Environment Variables",
  [CfnKey.IAM_INSTANCE_PROFILE]: "IAM Instance Profile",
  [CfnKey.USER_DATA]: "User Data",
  [CfnKey.KMS_MASTER_KEY_ID_S3]: "KMS Key ID",
  [CfnKey.ENABLE_LIFECYCLE]: "Lifecycle Rules",
  [CfnKey.ENABLE_CORS]: "CORS",
  [CfnKey.ENABLE_REPLICATION]: "Cross-Region Replication",
  [CfnKey.METADATA_OPTIONS]: "Instance Metadata",
  [CfnKey.BLOCK_DEVICE_MAPPINGS]: "Storage",
  [CfnKey.DISABLE_API_TERMINATION]: "Termination Protection",
  [CfnKey.EBS_OPTIMIZED]: "EBS Optimized",
  [CfnKey.ASSOCIATE_PUBLIC_IP]: "Public IP",
  [CfnKey.CREDIT_SPECIFICATION]: "CPU Credits",
  [CfnKey.MONITORING]: "Detailed Monitoring",
  // VPC / Networking
  [CfnKey.CIDR_BLOCK]: "CIDR Block",
  [CfnKey.VPC_ID]: "VPC",
  [CfnKey.ENABLE_DNS_SUPPORT]: "DNS Support",
  [CfnKey.ENABLE_DNS_HOSTNAMES]: "DNS Hostnames",
  [CfnKey.AVAILABILITY_ZONE]: "Availability Zone",
  [CfnKey.MAP_PUBLIC_IP]: "Auto-Assign Public IP",
  // Security Group
  [CfnKey.GROUP_DESCRIPTION]: "Description",
  [CfnKey.SG_INGRESS]: "Inbound Rules",
  [CfnKey.SG_EGRESS]: "Outbound Rules",
  // DynamoDB
  [CfnKey.TABLE_NAME]: "Table Name",
  [CfnKey.BILLING_MODE]: "Billing Mode",
  [CfnKey.KEY_SCHEMA]: "Key Schema",
  [CfnKey.ATTRIBUTE_DEFINITIONS]: "Attributes",
  [CfnKey.PITR_ENABLED]: "Point-in-Time Recovery",
  [CfnKey.DELETION_PROTECTION_ENABLED]: "Deletion Protection",
  [CfnKey.SSE_SPECIFICATION]: "Encryption",
  // SQS
  [CfnKey.QUEUE_NAME]: "Queue Name",
  [CfnKey.FIFO_QUEUE]: "FIFO Queue",
  [CfnKey.VISIBILITY_TIMEOUT]: "Visibility Timeout (s)",
  [CfnKey.MESSAGE_RETENTION]: "Message Retention (s)",
  [CfnKey.DELAY_SECONDS]: "Delivery Delay (s)",
  [CfnKey.REDRIVE_POLICY]: "Dead Letter Queue",
  // SNS
  [CfnKey.TOPIC_NAME]: "Topic Name",
  [CfnKey.FIFO_TOPIC]: "FIFO Topic",
  [CfnKey.DISPLAY_NAME]: "Display Name",
  // CloudWatch
  [CfnKey.ALARM_NAME]: "Alarm Name",
  [CfnKey.METRIC_NAME]: "Metric Name",
  [CfnKey.NAMESPACE]: "Namespace",
  [CfnKey.THRESHOLD]: "Threshold",
  [CfnKey.COMPARISON_OPERATOR]: "Comparison",
  [CfnKey.STATISTIC]: "Statistic",
  [CfnKey.PERIOD]: "Period (s)",
  [CfnKey.EVALUATION_PERIODS]: "Evaluation Periods",
  [CfnKey.TREAT_MISSING_DATA]: "Treat Missing Data",
  [CfnKey.ALARM_ACTIONS]: "Alarm Actions",
  // CloudWatch Logs
  [CfnKey.LOG_GROUP_NAME]: "Log Group Name",
  [CfnKey.RETENTION_IN_DAYS]: "Log Retention (days)",
  [CfnKey.KMS_KEY_ID]: "KMS Key",
  // IAM
  [CfnKey.ROLE_NAME]: "Role Name",
  [CfnKey.ASSUME_ROLE_POLICY]: "Trust Policy",
  [CfnKey.MANAGED_POLICY_ARNS]: "Managed Policies",
  [CfnKey.MAX_SESSION_DURATION]: "Max Session (s)",
  // ELBv2
  // NOTE: CfnKey.TYPE ("Type") is ambiguous — see FRIENDLY_NAMES_BY_TYPE.
  [CfnKey.SCHEME]: "Scheme",
  [CfnKey.SUBNETS]: "Subnets",
  // API Gateway
  [CfnKey.PROTOCOL_TYPE]: "Protocol",
  // Secrets Manager
  [CfnKey.GENERATE_SECRET_STRING]: "Generate Secret String",
  [CfnKey.KMS_MASTER_KEY_ID]: "KMS Key",
  // SSM
  [CfnKey.TIER]: "Tier",
  // RDS additional
  [CfnKey.STORAGE_ENCRYPTED]: "Storage Encryption",
  [CfnKey.PUBLICLY_ACCESSIBLE]: "Publicly Accessible",
  [CfnKey.DB_SUBNET_GROUP_NAME]: "DB Subnet Group",
  [CfnKey.VPC_SECURITY_GROUP_IDS]: "VPC Security Groups",
};
