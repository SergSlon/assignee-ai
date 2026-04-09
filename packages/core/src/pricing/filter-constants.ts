/**
 * AWS Pricing API constants — single source of truth for filter fields,
 * match types, service codes, and product families used in decomposers
 * and strategies.
 */

export const PricingMatchType = {
  TERM_MATCH: "TERM_MATCH",
} as const;

export const PricingField = {
  PRODUCT_FAMILY: "productFamily",
  USAGE_TYPE: "usagetype",
  INSTANCE_TYPE: "instanceType",
  OPERATING_SYSTEM: "operatingSystem",
  TENANCY: "tenancy",
  CAPACITY_STATUS: "capacitystatus",
  PRE_INSTALLED_SW: "preInstalledSw",
  DATABASE_ENGINE: "databaseEngine",
  DEPLOYMENT_OPTION: "deploymentOption",
  VOLUME_API_NAME: "volumeApiName",
  VOLUME_TYPE: "volumeType",
  GROUP: "group",
  ALARM_TYPE: "alarmType",
  FROM_LOCATION_TYPE: "fromLocationType",
  TO_LOCATION_TYPE: "toLocationType",
  TRANSFER_TYPE: "transferType",
} as const;

export const PricingServiceCode = {
  S3: "AmazonS3",
  EC2: "AmazonEC2",
  RDS: "AmazonRDS",
  LAMBDA: "AWSLambda",
  DYNAMODB: "AmazonDynamoDB",
  SQS: "AmazonSQS",
  SNS: "AmazonSNS",
  ELB: "ElasticLoadBalancing",
  ECR: "AmazonECR",
  CLOUDWATCH: "AmazonCloudWatch",
  API_GATEWAY: "AmazonApiGateway",
  SECRETS_MANAGER: "AWSSecretsManager",
  SSM: "AWSSystemsManager",
  VPC: "AmazonVPC",
  DATA_TRANSFER: "AWSDataTransfer",
  // A1 (2026-04-08) — EFS
  EFS: "AmazonEFS",
  // A11 (2026-04-09) — KMS::Key
  KMS: "awskms",
  // A13 (2026-04-09) — EventBridge (shared with Events::Rule cost reqs
  // and the ApiDestination per-invocation fee; not previously needed
  // because Events::Rule + Events::EventBus are modelled as free).
  EVENTS: "AmazonEventBridge",
  // A14 (2026-04-09) — CloudFront::Distribution
  CLOUDFRONT: "AmazonCloudFront",
} as const;

export const PricingKind = {
  FIXED: "fixed" as const,
  USAGE_BASED: "usage_based" as const,
} as const;

export const PricingProductFamily = {
  // S3
  STORAGE: "Storage",
  API_REQUEST: "API Request",
  DATA_TRANSFER: "Data Transfer",
  // EC2
  COMPUTE_INSTANCE: "Compute Instance",
  IP_ADDRESS: "IP Address",
  NAT_GATEWAY: "NAT Gateway",
  // RDS
  DATABASE_INSTANCE: "Database Instance",
  DATABASE_STORAGE: "Database Storage",
  STORAGE_SNAPSHOT: "Storage Snapshot",
  // Lambda
  SERVERLESS: "Serverless",
  DATA_PAYLOAD: "Data Payload",
  // DynamoDB
  PROVISIONED_IOPS: "Provisioned IOPS",
  PAY_PER_REQUEST: "Amazon DynamoDB PayPerRequest Throughput",
  // SQS
  QUEUE: "Queue",
  FIFO_QUEUE: "FIFO Queue",
  // SNS
  MESSAGE_DELIVERY: "Message Delivery",
  // ELB
  LOAD_BALANCER: "Load Balancer",
  LOAD_BALANCER_APPLICATION: "Load Balancer-Application",
  LOAD_BALANCER_NETWORK: "Load Balancer-Network",
  // ECR
  CONTAINER_REGISTRY: "EC2 Container Registry",
  // CloudWatch
  ALARM: "Alarm",
  LOGS: "Logs",
  // API Gateway
  WEBSOCKET: "WebSocket",
  API_CALLS: "API Calls",
  // Secrets Manager
  SECRET: "Secret",
  // SSM
  SYSTEMS_MANAGER: "AWS Systems Manager",
  // A11 (2026-04-09) — KMS
  ENCRYPTION_KEY: "Encryption Key",
} as const;

/** Standard free tier message used for resources with no usage limits. */
export const FREE_TIER_MESSAGE = "Always free tier" as const;

/** Static cost estimate labels used when no pricing API query is needed. */
export const CostEstimateLabel = {
  FREE: "Free",
  NO_CHARGE: "No charge",
  NA: "N/A",
} as const;
