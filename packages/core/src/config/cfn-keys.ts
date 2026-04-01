/**
 * CloudFormation property key constants — single source of truth.
 * Use these instead of raw strings in plugins, decomposers, and graph nodes.
 *
 * @see Story 42.9
 */
export const CfnKey = {
  // ── Common / shared ─────────────────────────────────────────
  TAGS: "Tags",
  NAME: "Name",
  DESCRIPTION: "Description",

  // ── S3 ──────────────────────────────────────────────────────
  BUCKET_NAME: "BucketName",
  BUCKET_ENCRYPTION: "BucketEncryption",
  PUBLIC_ACCESS_BLOCK: "PublicAccessBlockConfiguration",
  VERSIONING_CONFIGURATION: "VersioningConfiguration",
  LIFECYCLE_CONFIGURATION: "LifecycleConfiguration",
  CORS_CONFIGURATION: "CorsConfiguration",
  REPLICATION_CONFIGURATION: "ReplicationConfiguration",

  // ── EC2 ─────────────────────────────────────────────────────
  INSTANCE_TYPE: "InstanceType",
  IMAGE_ID: "ImageId",
  KEY_NAME: "KeyName",
  SUBNET_ID: "SubnetId",
  SECURITY_GROUP_IDS: "SecurityGroupIds",
  ASSOCIATE_PUBLIC_IP: "AssociatePublicIpAddress",
  BLOCK_DEVICE_MAPPINGS: "BlockDeviceMappings",
  METADATA_OPTIONS: "MetadataOptions",
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
} as const;

export type CfnKeyType = (typeof CfnKey)[keyof typeof CfnKey];
