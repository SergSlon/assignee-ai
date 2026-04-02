/**
 * CloudFormation property key constants — single source of truth.
 * Use these instead of raw strings in plugins, decomposers, and graph nodes.
 *
 * @see Story 42.9
 */
/** The `.assignee` directory name — single source of truth for project/home config paths. */
export const ASSIGNEE_DIR = ".assignee";

export const CfnKey = {
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
  VPC_SECURITY_GROUP_IDS: "VpcSecurityGroupIds",
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

  // ── CloudWatch ──────────────────────────────────────────────
  ALARM_NAME: "AlarmName",
  METRIC_NAME: "MetricName",
  NAMESPACE: "Namespace",
  THRESHOLD: "Threshold",
  COMPARISON_OPERATOR: "ComparisonOperator",
  ALARM_ACTIONS: "AlarmActions",
  STATISTIC: "Statistic",
  PERIOD: "Period",
  EVALUATION_PERIODS: "EvaluationPeriods",
  OK_ACTIONS: "OKActions",
  INSUFFICIENT_DATA_ACTIONS: "InsufficientDataActions",
  DIMENSIONS: "Dimensions",
  TREAT_MISSING_DATA: "TreatMissingData",
  DATAPOINTS_TO_ALARM: "DatapointsToAlarm",

  // ── CloudWatch Logs ─────────────────────────────────────────
  LOG_GROUP_NAME: "LogGroupName",
  RETENTION_IN_DAYS: "RetentionInDays",
  KMS_KEY_ID: "KmsKeyId",
  LOG_GROUP_CLASS: "LogGroupClass",
  DATA_PROTECTION_POLICY: "DataProtectionPolicy",

  // ── IAM ─────────────────────────────────────────────────────
  ROLE_NAME: "RoleName",
  ASSUME_ROLE_POLICY: "AssumeRolePolicyDocument",
  MAX_SESSION_DURATION: "MaxSessionDuration",
  PERMISSIONS_BOUNDARY: "PermissionsBoundary",
  MANAGED_POLICY_ARNS: "ManagedPolicyArns",

  // ── Security Group ──────────────────────────────────────────
  GROUP_DESCRIPTION: "GroupDescription",
  VPC_ID: "VpcId",
  SG_INGRESS: "SecurityGroupIngress",
  SG_EGRESS: "SecurityGroupEgress",
  FROM_PORT: "FromPort",
  TO_PORT: "ToPort",

  // ── ELBv2 ───────────────────────────────────────────────────
  TYPE: "Type",
  SCHEME: "Scheme",
  SUBNETS: "Subnets",
  IP_ADDRESS_TYPE: "IpAddressType",

  // ── API Gateway V2 ──────────────────────────────────────────
  PROTOCOL_TYPE: "ProtocolType",
  DISABLE_EXECUTE_API: "DisableExecuteApiEndpoint",
  ROUTE_SELECTION_EXPRESSION: "RouteSelectionExpression",
  VERSION: "Version",

  // ── Secrets Manager ─────────────────────────────────────────
  GENERATE_SECRET_STRING: "GenerateSecretString",
  SECRET_STRING: "SecretString",
  REPLICA_REGIONS: "ReplicaRegions",
  PASSWORD: "Password",
  ACCESS_KEY: "AccessKey",
  SECRET_ACCESS_KEY: "SecretAccessKey",
  SESSION_TOKEN: "SessionToken",

  // ── SSM ─────────────────────────────────────────────────────
  SSM_TYPE: "Type",
  SSM_VALUE: "Value",
  TIER: "Tier",

  // ── ECR ─────────────────────────────────────────────────────
  REPOSITORY_NAME: "RepositoryName",
  IMAGE_TAG_MUTABILITY: "ImageTagMutability",
  SCAN_ON_PUSH: "ScanOnPush",
  IMAGE_SCANNING_CONFIGURATION: "ImageScanningConfiguration",
  ENCRYPTION_TYPE: "EncryptionType",
  ENCRYPTION_CONFIGURATION: "EncryptionConfiguration",
  LIFECYCLE_POLICY_TEXT: "LifecyclePolicyText",

  // ── ECS ─────────────────────────────────────────────────────
  CLUSTER_NAME: "ClusterName",
  CONTAINER_INSIGHTS: "ContainerInsights",
  CLUSTER_SETTINGS: "ClusterSettings",
  CAPACITY_PROVIDERS: "CapacityProviders",
  DEFAULT_CAPACITY_STRATEGY: "DefaultCapacityProviderStrategy",

  // ── VPC / Networking ────────────────────────────────────────
  CIDR_BLOCK: "CidrBlock",
  ENABLE_DNS_HOSTNAMES: "EnableDnsHostnames",
  ENABLE_DNS_SUPPORT: "EnableDnsSupport",
  INSTANCE_TENANCY: "InstanceTenancy",
  AVAILABILITY_ZONE: "AvailabilityZone",
  MAP_PUBLIC_IP: "MapPublicIpOnLaunch",
  ROUTE_TABLE_ID: "RouteTableId",
  DESTINATION_CIDR_BLOCK: "DestinationCidrBlock",
  GATEWAY_ID: "GatewayId",
  NAT_GATEWAY_ID: "NatGatewayId",
  CONNECTIVITY_TYPE: "ConnectivityType",
  ALLOCATION_ID: "AllocationId",
  MAX_DRAIN_DURATION: "MaxDrainDurationSeconds",
  DOMAIN: "Domain",

  // ── EBS (nested under BlockDeviceMappings) ─────────────────
  EBS: "Ebs",
  VOLUME_TYPE: "VolumeType",
  VOLUME_SIZE: "VolumeSize",
  ENCRYPTED: "Encrypted",

  // ── Lambda Event Source Mapping ────────────────────────────
  EVENT_SOURCE_ARN: "EventSourceArn",
  BATCH_SIZE: "BatchSize",
  STARTING_POSITION: "StartingPosition",
  ENABLED: "Enabled",

  // ── SNS Subscription ──────────────────────────────────────
  TOPIC_ARN: "TopicArn",
  PROTOCOL: "Protocol",
  ENDPOINT: "Endpoint",

  // ── S3 Lifecycle (nested keys) ─────────────────────────────
  RULES: "Rules",
  TRANSITIONS: "Transitions",
  TRANSITION_IN_DAYS: "TransitionInDays",
  EXPIRATION_IN_DAYS: "ExpirationInDays",
  CORS_RULES: "CorsRules",

  // ── Auto-populated / read-only fields (drift comparison) ──
  CREATION_DATE: "CreationDate",
  LAST_MODIFIED_DATE: "LastModifiedDate",
  LAST_MODIFIED_TIME: "LastModifiedTime",
  OWNER_ID: "OwnerId",
  ACCOUNT_ID: "AccountId",
  DOMAIN_NAME_CFN: "DomainName",
  REGIONAL_DOMAIN_NAME: "RegionalDomainName",
  DUAL_STACK_DOMAIN_NAME: "DualStackDomainName",
  WEBSITE_URL: "WebsiteURL",

  // ── Plugin-level keys (not direct CFN properties) ──────────
  LOG_RETENTION_IN_DAYS: "LogRetentionInDays",

  // ── Wizard-only fields (not real CFN properties) ────────────
  // Used as plugin field names and cleaned up in plan-generator
  // assembly functions before sending to CloudFormation.
  KMS_MASTER_KEY_ID_S3: "KMSMasterKeyID",
  ENABLE_LIFECYCLE: "EnableLifecycle",
  LIFECYCLE_TRANSITION_DAYS: "LifecycleTransitionDays",
  LIFECYCLE_EXPIRATION_DAYS: "LifecycleExpirationDays",
  ENABLE_CORS: "EnableCors",
  CORS_ALLOWED_ORIGINS: "CorsAllowedOrigins",
  CORS_ALLOWED_METHODS: "CorsAllowedMethods",
  ENABLE_REPLICATION: "EnableReplication",
  REPLICATION_DESTINATION_BUCKET: "ReplicationDestinationBucket",
  EBS_VOLUME_TYPE: "EbsVolumeType",
  EBS_VOLUME_SIZE: "EbsVolumeSize",
  EBS_ENCRYPTED: "EbsEncrypted",

  // ── DynamoDB wizard-only ───────────────────────────────────
  PARTITION_KEY: "PartitionKey",
  SORT_KEY: "SortKey",

  // ── EC2 Route wizard-only ──────────────────────────────────
  ROUTE_TYPE: "RouteType",

  // ── ECR wizard-only ────────────────────────────────────────
  KMS_KEY: "KmsKey",

  // ── ELBv2 wizard-only ──────────────────────────────────────
  SECURITY_GROUPS: "SecurityGroups",

  // ── Lambda wizard-only ─────────────────────────────────────
  VPC_SUBNET_IDS: "VpcSubnetIds",

  // ── SecretsManager wizard-only ─────────────────────────────
  GENERATE_SECRET_STRING_CONFIG: "GenerateSecretStringConfig",

  // ── API Gateway V2 wizard-only ─────────────────────────────
  CORS_ALLOW_ORIGINS: "CorsAllowOrigins",
  CORS_ALLOW_METHODS: "CorsAllowMethods",
  CORS_ALLOW_HEADERS: "CorsAllowHeaders",

  // ── Generic plugin wizard-only ─────────────────────────────
  RESOURCE_NAME: "ResourceName",

  // ── CloudFormation schema keys (lowercase in Registry SDK) ─
  CFN_PROPERTIES: "properties",
  CFN_REQUIRED: "required",
  CFN_TYPE_NAME: "typeName",
  CFN_DESCRIPTION: "description",
  CFN_READ_ONLY_PROPERTIES: "readOnlyProperties",
  CFN_PRIMARY_IDENTIFIER: "primaryIdentifier",
  CFN_ADDITIONAL_PROPERTIES: "additionalProperties",
  CFN_DEFINITIONS: "definitions",
  CFN_CREATE_ONLY_PROPERTIES: "createOnlyProperties",
  CFN_WRITE_ONLY_PROPERTIES: "writeOnlyProperties",

  // ── Internal / plan-assembly keys ─────────────────────────
  _LOGICAL_ID: "_logicalId",
  LOGICAL_ID: "logicalId",
  REGION: "region",
} as const;

export type CfnKeyType = (typeof CfnKey)[keyof typeof CfnKey];

/**
 * Sentinel value used by plan_generator to defer EIP allocation to apply time.
 * resource_provisioner replaces this with a real AllocationId at provision time.
 */
export const EIP_AUTO_ALLOCATE = "AUTO_ALLOCATE_EIP" as const;

/**
 * Tag key/value pair used to mark resources as managed by Assignee.ai.
 * Use instead of raw "managed-by" / "assignee-ai" strings.
 */
/**
 * Default values for resource properties used across plugins and decomposers.
 * Use instead of raw string literals like "gp3" or "postgres".
 */
export const ResourceDefault = {
  EBS_VOLUME_TYPE: "gp3",
  RDS_ENGINE_POSTGRES: "postgres",
} as const;

/**
 * AWS default values used across plugins, decomposers, strategies, and CLI code.
 * Use instead of raw string literals like "t3.micro", "application", etc.
 *
 * @see Story 42.10 — zero magic strings policy
 */
export const AwsDefault = {
  // ── EC2 ───────────────────────────────────────────────────────
  INSTANCE_TYPE: "t3.micro",
  EC2_AMI: "amazon-linux-2023",
  ARCH_X86: "x86_64",
  ARCH_ARM: "arm64",

  // ── RDS ───────────────────────────────────────────────────────
  DB_INSTANCE_CLASS: "db.t3.micro",
  RDS_ENGINE_POSTGRES: "postgres",
  RDS_ENGINE_MYSQL: "mysql",

  // ── EBS / Storage ─────────────────────────────────────────────
  EBS_VOLUME_TYPE: "gp3",

  // ── ELBv2 ─────────────────────────────────────────────────────
  LB_TYPE_APPLICATION: "application",
  LB_SCHEME_INTERNET_FACING: "internet-facing",

  // ── API Gateway V2 ────────────────────────────────────────────
  PROTOCOL_HTTP: "HTTP",
  PROTOCOL_WEBSOCKET: "WEBSOCKET",

  // ── CloudWatch / Logs ─────────────────────────────────────────
  LOG_CLASS_STANDARD: "STANDARD",
  LOG_CLASS_INFREQUENT: "INFREQUENT_ACCESS",

  // ── DynamoDB ──────────────────────────────────────────────────
  BILLING_PAY_PER_REQUEST: "PAY_PER_REQUEST",
  BILLING_PROVISIONED: "PROVISIONED",

  // ── ECS ───────────────────────────────────────────────────────
  CAPACITY_FARGATE: "FARGATE",
  CAPACITY_FARGATE_SPOT: "FARGATE_SPOT",

  // ── Connectivity / Visibility ──────────────────────────────────
  CONNECTIVITY_PUBLIC: "public",
  CONNECTIVITY_PRIVATE: "private",
  LB_SCHEME_INTERNAL: "internal",

  // ── Encryption ────────────────────────────────────────────────
  ENCRYPTION_AES256: "AES256",

  // ── Lambda ────────────────────────────────────────────────────
  LAMBDA_HANDLER: "index.handler",
  LAMBDA_RUNTIME: "nodejs22.x",

  // ── SSM ───────────────────────────────────────────────────────
  SSM_TIER_STANDARD: "Standard",
} as const;

export const AssigneeTag = {
  KEY: "managed-by",
  VALUE: "assignee-ai",
} as const;

/**
 * Human-readable display names for RDS database engines.
 * Used in wizard labels, pricing decomposers, and pricing lookups.
 *
 * @see Story 42.10 — zero magic strings policy
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
 *
 * @see Story 42.10 — zero magic strings policy
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
 *
 * @see Story 42.10 — zero magic strings policy
 */
export const AmiOs = {
  AMAZON_LINUX_2023: "amazon-linux-2023",
  WINDOWS_2022: "windows-2022",
  UBUNTU_24: "ubuntu-24.04",
  UBUNTU_22: "ubuntu-22.04",
} as const;

/**
 * RDS engine identifier strings used in wizard values and showIf conditions.
 *
 * @see Story 42.10 — zero magic strings policy
 */
export const RdsEngineId = {
  AURORA_MYSQL: "aurora-mysql",
  AURORA_POSTGRESQL: "aurora-postgresql",
} as const;

/**
 * Instance/storage size fit-hint labels used in wizard option metadata.
 *
 * @see Story 42.10 — zero magic strings policy
 */
export const SizeLabel = {
  SMALL_PRODUCTION: "Small production",
  MEDIUM_PRODUCTION: "Medium production",
  LATEST_GEN_COMPUTE: "Latest gen compute",
  BEST_PRICE_PERFORMANCE: "Best price-performance",
} as const;

/**
 * Hint string for RDS engine version fields.
 *
 * @see Story 42.10 — zero magic strings policy
 */
export const RDS_ENGINE_VERSION_HINT =
  "Newer versions offer better performance and security. Cannot be easily downgraded." as const;

/**
 * AWS service identifier for API Gateway V2 execute endpoints (as it appears in ARNs).
 *
 * @see Story 42.10 — zero magic strings policy
 */
export const AWS_SERVICE_EXECUTE_API = "execute-api" as const;

/** Generic "unknown" fallback for missing metadata fields (ARN parts, resource type, etc.). */
export const UNKNOWN_FALLBACK = "unknown" as const;
