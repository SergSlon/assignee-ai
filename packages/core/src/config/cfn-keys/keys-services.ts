/**
 * CfnKey entries for the second tier of AWS services:
 * CloudWatch, Logs, IAM, SecurityGroup, ELBv2, APIGatewayV2,
 * SecretsManager, SSM, ECR, ECS, VPC/Networking, EBS,
 * Lambda EventSourceMapping, SNS Subscription, EFS, S3 Lifecycle,
 * read-only drift fields, and wizard-only keys.
 *
 * Split out of `cfn-keys/keys.ts` for SRP / file-size compliance.
 */

export const CFN_KEYS_SERVICES = {
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

  // ── EFS (A1) ────────────────────────────────────────────────
  FILE_SYSTEM_TAGS: "FileSystemTags",
  PERFORMANCE_MODE: "PerformanceMode",
  THROUGHPUT_MODE: "ThroughputMode",
  PROVISIONED_THROUGHPUT_IN_MIBPS: "ProvisionedThroughputInMibps",
  BACKUP_POLICY: "BackupPolicy",
  BACKUP_POLICY_STATUS: "Status",
  LIFECYCLE_POLICIES: "LifecyclePolicies",
  FILE_SYSTEM_POLICY: "FileSystemPolicy",
  AVAILABILITY_ZONE_NAME: "AvailabilityZoneName",

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
} as const;
