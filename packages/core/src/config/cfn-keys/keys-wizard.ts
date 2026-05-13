/**
 * CfnKey entries for wizard-only / plan-assembly fields — strings that
 * surface in the plugin UIs and are cleaned up by plan-generator before
 * CloudFormation serialization.
 *
 * Also contains CloudFormation registry-SDK schema keys (lowercase) and
 * internal plan-assembly keys.
 *
 * Split out of `cfn-keys/keys.ts` for SRP / file-size compliance.
 */

export const CFN_KEYS_WIZARD = {
  // ── Wizard-only fields (not real CFN properties) ────────────
  KMS_MASTER_KEY_ID_S3: "KMSMasterKeyID",
  ENABLE_LIFECYCLE: "EnableLifecycle",
  LIFECYCLE_TRANSITION_DAYS: "LifecycleTransitionDays",
  LIFECYCLE_EXPIRATION_DAYS: "LifecycleExpirationDays",
  /** Set by s3-lifecycle-extractor when intent is bare "lifecycle Nd" — suppresses the IA transition. */
  LIFECYCLE_EXPIRE_ONLY: "LifecycleExpireOnly",
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
