/**
 * CfnKey entries for "core" AWS services:
 * common/shared, S3, EC2, RDS, Lambda, DynamoDB, SQS, SNS.
 *
 * Split out of `cfn-keys/keys.ts` for SRP / file-size compliance.
 * The merged `CfnKey` + `CfnKeyType` live in `./keys.ts`.
 */

export const CFN_KEYS_CORE = {
  // ── Common / shared ─────────────────────────────────────────
  TAGS: "Tags",
  TAG_KEY: "Key",
  TAG_VALUE: "Value",
  NAME: "Name",
  DESCRIPTION: "Description",
  STATUS: "Status",

  // ── S3 ──────────────────────────────────────────────────────
  BUCKET_NAME: "BucketName",
  BUCKET_ENCRYPTION: "BucketEncryption",
  PUBLIC_ACCESS_BLOCK: "PublicAccessBlockConfiguration",
  VERSIONING_CONFIGURATION: "VersioningConfiguration",
  LIFECYCLE_CONFIGURATION: "LifecycleConfiguration",
  CORS_CONFIGURATION: "CorsConfiguration",
  REPLICATION_CONFIGURATION: "ReplicationConfiguration",
  OWNERSHIP_CONTROLS: "OwnershipControls",
  SERVER_SIDE_ENCRYPTION_CONFIGURATION: "ServerSideEncryptionConfiguration",
  BLOCK_PUBLIC_ACLS: "BlockPublicAcls",
  BLOCK_PUBLIC_POLICY: "BlockPublicPolicy",
  IGNORE_PUBLIC_ACLS: "IgnorePublicAcls",
  RESTRICT_PUBLIC_BUCKETS: "RestrictPublicBuckets",

  // ── EC2 ─────────────────────────────────────────────────────
  INSTANCE_TYPE: "InstanceType",
  IMAGE_ID: "ImageId",
  KEY_NAME: "KeyName",
  SUBNET_ID: "SubnetId",
  SECURITY_GROUP_IDS: "SecurityGroupIds",
  ASSOCIATE_PUBLIC_IP: "AssociatePublicIpAddress",
  BLOCK_DEVICE_MAPPINGS: "BlockDeviceMappings",
  METADATA_OPTIONS: "MetadataOptions",
  HTTP_TOKENS: "HttpTokens",
  MONITORING: "Monitoring",
  CREDIT_SPECIFICATION: "CreditSpecification",
  DISABLE_API_TERMINATION: "DisableApiTermination",
  EBS_OPTIMIZED: "EbsOptimized",
  USER_DATA: "UserData",
  IAM_INSTANCE_PROFILE: "IamInstanceProfile",

  // ── RDS ─────────────────────────────────────────────────────
  DB_INSTANCE_CLASS: "DBInstanceClass",
  ENGINE: "Engine",
  ENGINE_VERSION: "EngineVersion",
  DB_NAME: "DBName",
  MASTER_USERNAME: "MasterUsername",
  MASTER_USER_PASSWORD: "MasterUserPassword",
  MULTI_AZ: "MultiAZ",
  DELETION_PROTECTION: "DeletionProtection",
  STORAGE_TYPE: "StorageType",
  ALLOCATED_STORAGE: "AllocatedStorage",
  PUBLICLY_ACCESSIBLE: "PubliclyAccessible",
  STORAGE_ENCRYPTED: "StorageEncrypted",
  DB_SUBNET_GROUP_NAME: "DBSubnetGroupName",
  DB_SUBNET_GROUP_DESCRIPTION: "DBSubnetGroupDescription",
  // CCAPI schema uses "VPCSecurityGroups" (all caps VPC), NOT
  // "VpcSecurityGroupIds" (which is the RDS SDK API key, not CFN/CCAPI).
  VPC_SECURITY_GROUP_IDS: "VPCSecurityGroups",
  PORT: "Port",
  ENABLE_CW_LOGS_EXPORTS: "EnableCloudwatchLogsExports",
  PERFORMANCE_INSIGHTS: "PerformanceInsightsEnabled",
  BACKUP_RETENTION_PERIOD: "BackupRetentionPeriod",

  // ── Lambda ──────────────────────────────────────────────────
  FUNCTION_NAME: "FunctionName",
  RUNTIME: "Runtime",
  HANDLER: "Handler",
  ROLE: "Role",
  MEMORY_SIZE: "MemorySize",
  TIMEOUT: "Timeout",
  ENVIRONMENT: "Environment",
  ARCHITECTURES: "Architectures",
  RESERVED_CONCURRENT_EXECUTIONS: "ReservedConcurrentExecutions",
  PROVISIONED_CONCURRENCY_CONFIG: "ProvisionedConcurrencyConfig",
  PROVISIONED_CONCURRENT_EXECUTIONS: "ProvisionedConcurrentExecutions",
  EPHEMERAL_STORAGE: "EphemeralStorage",
  LAYERS: "Layers",
  CODE: "Code",
  VPC_CONFIG: "VpcConfig",

  // ── DynamoDB ────────────────────────────────────────────────
  TABLE_NAME: "TableName",
  BILLING_MODE: "BillingMode",
  KEY_SCHEMA: "KeySchema",
  ATTRIBUTE_DEFINITIONS: "AttributeDefinitions",
  PROVISIONED_THROUGHPUT: "ProvisionedThroughput",
  READ_CAPACITY_UNITS: "ReadCapacityUnits",
  WRITE_CAPACITY_UNITS: "WriteCapacityUnits",
  PITR_ENABLED: "PointInTimeRecoveryEnabled",
  PITR_SPECIFICATION: "PointInTimeRecoverySpecification",
  DELETION_PROTECTION_ENABLED: "DeletionProtectionEnabled",
  SSE_ENABLED: "SSEEnabled",
  SSE_SPECIFICATION: "SSESpecification",

  // ── SQS ─────────────────────────────────────────────────────
  QUEUE_NAME: "QueueName",
  FIFO_QUEUE: "FifoQueue",
  VISIBILITY_TIMEOUT: "VisibilityTimeoutSeconds",
  MESSAGE_RETENTION: "MessageRetentionPeriod",
  DELAY_SECONDS: "DelaySeconds",
  MAX_MESSAGE_SIZE: "MaximumMessageSize",
  KMS_MASTER_KEY_ID: "KmsMasterKeyId",
  REDRIVE_POLICY: "RedrivePolicy",
  SQS_MANAGED_SSE: "SqsManagedSseEnabled",

  // ── SNS ─────────────────────────────────────────────────────
  TOPIC_NAME: "TopicName",
  FIFO_TOPIC: "FifoTopic",
  DISPLAY_NAME: "DisplayName",
  CONTENT_BASED_DEDUP: "ContentBasedDeduplication",
} as const;
