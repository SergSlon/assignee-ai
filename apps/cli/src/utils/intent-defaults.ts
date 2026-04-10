/**
 * Intent-aware smart defaults for the option elicitor.
 *
 * Maps keyword patterns in the user's intent string to field default overrides.
 * Uses simple case-insensitive substring matching — no LLM calls required.
 * First matching rule per field wins (no conflicting overrides).
 *
 * @see Story 10.5
 */

import { CfnKey, RESOURCE_TYPES, ResourceDefault } from "@assignee/core";
import type { ResourceField } from "@assignee/core";
import { WorkloadProfile as WP } from "../constants/workload-profiles.js";

/** A single field default override derived from intent analysis. */
export interface IntentDefaultOverride {
  /** CloudFormation property name, e.g. "InstanceType" */
  fieldName: string;
  /** Default value to inject */
  value: unknown;
  /** Explanation shown as clack hint, e.g. "Selected for web serving — burstable with 2 GiB RAM" */
  reason: string;
  /**
   * Tells the categorySelect renderer which category to pre-select,
   * skipping the category step. E.g., "burstable", "compute", "memory".
   * @see Story 18.12
   */
  categoryHint?: string;
}

/** Internal rule definition for keyword-to-override mapping. */
interface IntentRule {
  resourceType: string;
  keywords: string[];
  overrides: IntentDefaultOverride[];
}

const INTENT_RULES: IntentRule[] = [
  // EC2 — Web server
  {
    resourceType: RESOURCE_TYPES.EC2_INSTANCE,
    keywords: ["web server", "web app", "web service", "api server"],
    overrides: [
      {
        fieldName: CfnKey.INSTANCE_TYPE,
        value: "t3.small",
        reason: "Selected for web serving — burstable with 2 GiB RAM",
        categoryHint: WP.BURSTABLE,
      },
    ],
  },
  // EC2 — ML/Compute
  {
    resourceType: RESOURCE_TYPES.EC2_INSTANCE,
    keywords: ["machine learning", "ml training", "ml model", "deep learning"],
    overrides: [
      {
        fieldName: CfnKey.INSTANCE_TYPE,
        value: "c5.xlarge",
        reason: "Selected for ML/compute — 4 vCPU, 8 GiB, compute-optimized",
        categoryHint: WP.COMPUTE,
      },
    ],
  },
  // EC2 — SSH access (intent bundle: key pair + public IP + SG with port 22)
  {
    resourceType: RESOURCE_TYPES.EC2_INSTANCE,
    keywords: ["ssh"],
    overrides: [
      {
        fieldName: CfnKey.KEY_NAME,
        value: ResourceDefault.SSH_KEY_PLACEHOLDER,
        reason: "SSH bundle: key pair will be auto-created during provisioning",
      },
      {
        fieldName: CfnKey.ASSOCIATE_PUBLIC_IP,
        value: true,
        reason: "SSH bundle: public IP enabled for SSH reachability",
      },
      {
        fieldName: CfnKey.SECURITY_GROUP_IDS,
        value: [],
        reason:
          "SSH bundle: a security group with inbound port 22 will be auto-created by the companion resource system",
      },
    ],
  },
  // EC2 — Database/Cache
  {
    resourceType: RESOURCE_TYPES.EC2_INSTANCE,
    keywords: ["database", "db server", "cache", "redis", "memcached"],
    overrides: [
      {
        fieldName: CfnKey.INSTANCE_TYPE,
        value: "r5.large",
        reason: "Selected for data workloads — 16 GiB memory-optimized",
        categoryHint: WP.MEMORY,
      },
    ],
  },
  // S3 — Logging
  {
    resourceType: RESOURCE_TYPES.S3_BUCKET,
    keywords: ["logs", "logging", "log storage", "audit trail"],
    overrides: [
      {
        fieldName: CfnKey.ENABLE_LIFECYCLE,
        value: true,
        reason:
          "Pre-configured for log retention — 90-day IA transition, 365-day expiration",
      },
      {
        fieldName: CfnKey.LIFECYCLE_TRANSITION_DAYS,
        value: "90",
        reason:
          "Pre-configured for log retention — 90-day IA transition, 365-day expiration",
      },
      {
        fieldName: CfnKey.LIFECYCLE_EXPIRATION_DAYS,
        value: "365",
        reason:
          "Pre-configured for log retention — 90-day IA transition, 365-day expiration",
      },
    ],
  },
  // S3 — Static website
  {
    resourceType: RESOURCE_TYPES.S3_BUCKET,
    keywords: [
      "static website",
      "web hosting",
      "static site",
      "frontend hosting",
    ],
    overrides: [
      {
        fieldName: CfnKey.ENABLE_CORS,
        value: true,
        reason: "Pre-configured for static web hosting — CORS enabled",
      },
      {
        fieldName: CfnKey.PUBLIC_ACCESS_BLOCK,
        value: false,
        reason: "Pre-configured for static web hosting — public access allowed",
      },
    ],
  },
  // Lambda — API handler
  {
    resourceType: RESOURCE_TYPES.LAMBDA_FUNCTION,
    keywords: ["api handler", "api endpoint"],
    overrides: [
      {
        fieldName: CfnKey.MEMORY_SIZE,
        value: "512",
        reason:
          "Selected for API handling — 512 MB provides proportional CPU for fast response times",
      },
      {
        fieldName: CfnKey.TIMEOUT,
        value: "30",
        reason:
          "Selected for API handling — 30s timeout suits synchronous HTTP requests",
      },
    ],
  },
  // Lambda — Background job / worker
  {
    resourceType: RESOURCE_TYPES.LAMBDA_FUNCTION,
    keywords: ["background job", "worker"],
    overrides: [
      {
        fieldName: CfnKey.TIMEOUT,
        value: "300",
        reason:
          "Selected for background processing — 300s timeout for long-running tasks",
      },
    ],
  },
  // RDS — Production database
  {
    resourceType: RESOURCE_TYPES.RDS_DB_INSTANCE,
    keywords: ["production", "prod db", "production database"],
    overrides: [
      {
        fieldName: CfnKey.MULTI_AZ,
        value: true,
        reason:
          "Selected for production — Multi-AZ provides high availability with automatic failover",
      },
      {
        fieldName: CfnKey.BACKUP_RETENTION_PERIOD,
        value: "7",
        reason:
          "Selected for production — 7-day backup retention for point-in-time recovery",
      },
      {
        fieldName: CfnKey.DELETION_PROTECTION,
        value: true,
        reason:
          "Selected for production — deletion protection prevents accidental data loss",
      },
    ],
  },
  // RDS — Dev database
  {
    resourceType: RESOURCE_TYPES.RDS_DB_INSTANCE,
    keywords: ["dev database", "dev db"],
    overrides: [
      {
        fieldName: CfnKey.MULTI_AZ,
        value: false,
        reason:
          "Selected for development — single-AZ reduces cost for non-critical environments",
      },
    ],
  },
  // RDS — PostgreSQL
  {
    resourceType: RESOURCE_TYPES.RDS_DB_INSTANCE,
    keywords: ["postgres", "postgresql"],
    overrides: [
      {
        fieldName: CfnKey.ENGINE,
        value: "postgres",
        reason: "PostgreSQL selected — most popular open-source relational DB",
      },
    ],
  },
  // RDS — MySQL
  {
    resourceType: RESOURCE_TYPES.RDS_DB_INSTANCE,
    keywords: ["mysql"],
    overrides: [
      {
        fieldName: CfnKey.ENGINE,
        value: "mysql",
        reason: "MySQL selected — widely supported relational DB",
      },
    ],
  },
  // EC2 — Batch/compute-heavy
  {
    resourceType: RESOURCE_TYPES.EC2_INSTANCE,
    keywords: ["batch processing", "data processing", "etl"],
    overrides: [
      {
        fieldName: CfnKey.INSTANCE_TYPE,
        value: "c5.xlarge",
        reason: "Selected for batch/ETL — compute-optimized with 4 vCPU",
        categoryHint: WP.COMPUTE,
      },
    ],
  },
  // EC2 — Dev/test
  {
    resourceType: RESOURCE_TYPES.EC2_INSTANCE,
    keywords: ["dev", "test", "development", "testing", "sandbox"],
    overrides: [
      {
        fieldName: CfnKey.INSTANCE_TYPE,
        value: "t3.micro",
        reason: "Selected for dev/test — burstable, free tier eligible",
        categoryHint: WP.BURSTABLE,
      },
    ],
  },
  // EC2 — Docker/container host
  {
    resourceType: RESOURCE_TYPES.EC2_INSTANCE,
    keywords: ["docker", "container host", "containers"],
    overrides: [
      {
        fieldName: CfnKey.INSTANCE_TYPE,
        value: "t3.medium",
        reason:
          "Selected for container hosting — 4 GiB for Docker daemon + containers",
        categoryHint: WP.BURSTABLE,
      },
    ],
  },
  // Lambda — Scheduled/cron task
  {
    resourceType: RESOURCE_TYPES.LAMBDA_FUNCTION,
    keywords: ["scheduled", "cron", "periodic", "timer"],
    overrides: [
      {
        fieldName: CfnKey.TIMEOUT,
        value: "300",
        reason: "Selected for scheduled tasks — 300s timeout for batch work",
      },
    ],
  },
  // Lambda — Event processor
  {
    resourceType: RESOURCE_TYPES.LAMBDA_FUNCTION,
    keywords: ["event", "sqs trigger", "sns trigger", "s3 trigger"],
    overrides: [
      {
        fieldName: CfnKey.MEMORY_SIZE,
        value: "256",
        reason:
          "Selected for event processing — 256 MB suits most event payloads",
      },
      {
        fieldName: CfnKey.TIMEOUT,
        value: "60",
        reason:
          "Selected for event processing — 60s timeout for async event handling",
      },
    ],
  },
  // S3 — Backup/archive
  {
    resourceType: RESOURCE_TYPES.S3_BUCKET,
    keywords: ["backup", "archive", "cold storage"],
    overrides: [
      {
        fieldName: CfnKey.ENABLE_LIFECYCLE,
        value: true,
        reason:
          "Pre-configured for backup — lifecycle transitions to reduce cost",
      },
      {
        fieldName: CfnKey.LIFECYCLE_TRANSITION_DAYS,
        value: "30",
        reason:
          "Pre-configured for backup — move to Infrequent Access after 30 days",
      },
    ],
  },
  // S3 — Data lake
  {
    resourceType: RESOURCE_TYPES.S3_BUCKET,
    keywords: ["data lake", "analytics", "data warehouse"],
    overrides: [
      {
        fieldName: CfnKey.ENABLE_LIFECYCLE,
        value: true,
        reason:
          "Pre-configured for data lake — intelligent tiering for mixed access patterns",
      },
    ],
  },
  // DynamoDB — High throughput
  {
    resourceType: RESOURCE_TYPES.DYNAMODB_TABLE,
    keywords: ["high throughput", "high performance"],
    overrides: [
      {
        fieldName: CfnKey.BILLING_MODE,
        value: "PROVISIONED",
        reason:
          "Provisioned capacity selected — predictable cost for sustained high throughput",
      },
    ],
  },
  // DynamoDB — Serverless / variable
  {
    resourceType: RESOURCE_TYPES.DYNAMODB_TABLE,
    keywords: ["serverless", "variable", "unpredictable", "on demand"],
    overrides: [
      {
        fieldName: CfnKey.BILLING_MODE,
        value: "PAY_PER_REQUEST",
        reason:
          "On-demand selected — auto-scales with no capacity planning needed",
      },
    ],
  },
  // SQS — FIFO queue
  {
    resourceType: RESOURCE_TYPES.SQS_QUEUE,
    keywords: ["fifo", "ordered", "exactly-once", "deduplication"],
    overrides: [
      {
        fieldName: CfnKey.FIFO_QUEUE,
        value: true,
        reason:
          "FIFO queue selected — guarantees message ordering and exactly-once delivery",
      },
    ],
  },
  // SQS — Dead letter queue
  {
    resourceType: RESOURCE_TYPES.SQS_QUEUE,
    keywords: ["dead letter", "dlq", "failed messages"],
    overrides: [
      {
        fieldName: CfnKey.FIFO_QUEUE,
        value: false,
        reason:
          "Standard queue for DLQ — collects failed messages for retry/analysis",
      },
    ],
  },
  // CloudWatch — Monitoring alarm
  {
    resourceType: RESOURCE_TYPES.CLOUDWATCH_ALARM,
    keywords: ["cpu", "cpu alarm", "cpu monitoring"],
    overrides: [
      {
        fieldName: CfnKey.METRIC_NAME,
        value: "CPUUtilization",
        reason: "CPU monitoring selected — tracks EC2/ECS compute utilization",
      },
      {
        fieldName: CfnKey.NAMESPACE,
        value: "AWS/EC2",
        reason: "EC2 namespace selected for CPU metric",
      },
    ],
  },
  // CloudWatch — Memory alarm
  {
    resourceType: RESOURCE_TYPES.CLOUDWATCH_ALARM,
    keywords: ["memory", "memory alarm"],
    overrides: [
      {
        fieldName: CfnKey.METRIC_NAME,
        value: "MemoryUtilization",
        reason: "Memory monitoring — requires CloudWatch Agent on EC2",
      },
    ],
  },
  // SecretsManager — API key
  {
    resourceType: RESOURCE_TYPES.SECRETSMANAGER_SECRET,
    keywords: ["api key", "api secret", "token"],
    overrides: [
      {
        fieldName: CfnKey.GENERATE_SECRET_STRING,
        value: { PasswordLength: 64, ExcludePunctuation: true },
        reason: "API key pattern — 64-char alphanumeric for URL-safe usage",
      },
    ],
  },
  // SecretsManager — Database password
  {
    resourceType: RESOURCE_TYPES.SECRETSMANAGER_SECRET,
    keywords: ["database password", "db password", "rds password"],
    overrides: [
      {
        fieldName: CfnKey.GENERATE_SECRET_STRING,
        value: { PasswordLength: 32, ExcludePunctuation: false },
        reason:
          "Database password — 32-char with special characters for RDS compatibility",
      },
    ],
  },
  // IAM Role — Lambda execution
  {
    resourceType: RESOURCE_TYPES.IAM_ROLE,
    keywords: [
      "lambda execution role",
      "lambda role",
      "function execution role",
    ],
    overrides: [
      {
        fieldName: CfnKey.ASSUME_ROLE_POLICY,
        value: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { Service: "lambda.amazonaws.com" },
              Action: "sts:AssumeRole",
            },
          ],
        }),
        reason:
          "Lambda execution role — allows Lambda service to assume this role",
      },
    ],
  },
  // IAM Role — EC2 instance profile
  {
    resourceType: RESOURCE_TYPES.IAM_ROLE,
    keywords: ["ec2", "instance profile", "instance role"],
    overrides: [
      {
        fieldName: CfnKey.ASSUME_ROLE_POLICY,
        value: JSON.stringify({
          Version: "2012-10-17",
          Statement: [
            {
              Effect: "Allow",
              Principal: { Service: "ec2.amazonaws.com" },
              Action: "sts:AssumeRole",
            },
          ],
        }),
        reason: "EC2 instance role — allows EC2 service to assume this role",
      },
    ],
  },
  // SSM Parameter — Secret/password
  {
    resourceType: RESOURCE_TYPES.SSM_PARAMETER,
    keywords: ["secret", "password", "credential", "token"],
    overrides: [
      {
        fieldName: CfnKey.SSM_TYPE,
        value: "SecureString",
        reason:
          "SecureString selected — encrypts value with KMS for sensitive data",
      },
    ],
  },
  // SNS Topic — FIFO
  {
    resourceType: RESOURCE_TYPES.SNS_TOPIC,
    keywords: ["fifo", "ordered", "exactly-once"],
    overrides: [
      {
        fieldName: CfnKey.FIFO_TOPIC,
        value: true,
        reason:
          "FIFO topic selected — guarantees message ordering and deduplication",
      },
      {
        fieldName: CfnKey.CONTENT_BASED_DEDUP,
        value: true,
        reason:
          "Content-based deduplication enabled — prevents duplicate messages",
      },
    ],
  },
  // SNS Topic — Notifications/alerts
  {
    resourceType: RESOURCE_TYPES.SNS_TOPIC,
    keywords: ["notification", "alert", "email", "sms"],
    overrides: [
      {
        fieldName: CfnKey.DISPLAY_NAME,
        value: "Assignee Notifications",
        reason:
          "Display name set for SMS/email notification sender identification",
      },
    ],
  },
  // CloudWatch LogGroup — Long retention
  {
    resourceType: RESOURCE_TYPES.LOGS_LOG_GROUP,
    keywords: ["compliance", "audit", "long-term", "archive"],
    overrides: [
      {
        fieldName: CfnKey.RETENTION_IN_DAYS,
        value: "365",
        reason: "365-day retention for compliance/audit log storage",
      },
    ],
  },
  // CloudWatch LogGroup — Short retention
  {
    resourceType: RESOURCE_TYPES.LOGS_LOG_GROUP,
    keywords: ["dev", "debug", "test", "temporary"],
    overrides: [
      {
        fieldName: CfnKey.RETENTION_IN_DAYS,
        value: "7",
        reason: "7-day retention for dev/test — reduces storage cost",
      },
    ],
  },
  // ECS Cluster — Fargate
  {
    resourceType: RESOURCE_TYPES.ECS_CLUSTER,
    keywords: ["fargate", "serverless"],
    overrides: [
      {
        fieldName: CfnKey.CLUSTER_SETTINGS,
        value: [{ Name: "containerInsights", Value: "enabled" }],
        reason: "Container Insights enabled for Fargate observability",
      },
    ],
  },
  // ECR Repository — Docker/container images
  {
    resourceType: RESOURCE_TYPES.ECR_REPOSITORY,
    keywords: ["docker", "container", "image"],
    overrides: [
      {
        fieldName: CfnKey.IMAGE_TAG_MUTABILITY,
        value: "IMMUTABLE",
        reason:
          "Immutable tags prevent overwriting — safer for production deployments",
      },
      {
        fieldName: CfnKey.SCAN_ON_PUSH,
        value: true,
        reason:
          "Scan on push enabled — detect vulnerabilities in container images",
      },
    ],
  },
  // ELBv2 — Application Load Balancer
  {
    resourceType: RESOURCE_TYPES.ELBV2_LOAD_BALANCER,
    keywords: ["web", "http", "https", "api gateway", "application"],
    overrides: [
      {
        fieldName: CfnKey.TYPE,
        value: "application",
        reason:
          "Application Load Balancer for HTTP/HTTPS traffic with path-based routing",
      },
    ],
  },
  // ELBv2 — Network Load Balancer
  {
    resourceType: RESOURCE_TYPES.ELBV2_LOAD_BALANCER,
    keywords: ["tcp", "udp", "network", "high performance", "low latency"],
    overrides: [
      {
        fieldName: CfnKey.TYPE,
        value: "network",
        reason: "Network Load Balancer for TCP/UDP with ultra-low latency",
      },
    ],
  },
  // API Gateway V2 — HTTP API
  {
    resourceType: RESOURCE_TYPES.APIGATEWAYV2_API,
    keywords: ["http api", "rest api", "api endpoint"],
    overrides: [
      {
        fieldName: CfnKey.PROTOCOL_TYPE,
        value: "HTTP",
        reason: "HTTP API selected — lower cost and latency than REST API",
      },
    ],
  },
  // API Gateway V2 — WebSocket
  {
    resourceType: RESOURCE_TYPES.APIGATEWAYV2_API,
    keywords: ["websocket", "real-time", "chat", "streaming"],
    overrides: [
      {
        fieldName: CfnKey.PROTOCOL_TYPE,
        value: "WEBSOCKET",
        reason: "WebSocket API for real-time bidirectional communication",
      },
    ],
  },
];

/**
 * Analyzes the user intent string and returns field default overrides
 * for the given resource type. Uses case-insensitive substring matching.
 * First matching rule per field wins — no conflicting overrides.
 *
 * @param userIntent  - The user's natural-language intent string
 * @param resourceType - CloudFormation resource type, e.g. RESOURCE_TYPES.EC2_INSTANCE
 * @returns Array of field overrides (empty if no keywords match)
 */
export function getIntentDefaults(
  userIntent: string,
  resourceType: string,
): IntentDefaultOverride[] {
  if (!userIntent || !resourceType) return [];

  const intentLower = userIntent.toLowerCase();
  const claimedFields = new Set<string>();
  const overrides: IntentDefaultOverride[] = [];

  for (const rule of INTENT_RULES) {
    if (rule.resourceType !== resourceType) continue;

    const matches = rule.keywords.some((kw) => intentLower.includes(kw));
    if (!matches) continue;

    for (const override of rule.overrides) {
      // First match per field wins
      if (claimedFields.has(override.fieldName)) continue;
      claimedFields.add(override.fieldName);
      overrides.push(override);
    }
  }

  return overrides;
}

/**
 * Applies intent-derived default overrides to resource fields.
 * Modifies initialValue and appends reason hint to each matching field.
 * Pure function — no mutations to input arrays.
 */
export function applyIntentOverrides(
  fields: ResourceField[],
  overrides: IntentDefaultOverride[],
): ResourceField[] {
  if (overrides.length === 0) return fields;

  const overrideMap = new Map(overrides.map((o) => [o.fieldName, o]));

  return fields.map((field) => {
    const override = overrideMap.get(field.name);
    if (!override) return field;

    const intentHint = `Pre-selected based on your intent: ${override.reason}`;
    const existingHint = field.question.hint;
    const combinedHint = existingHint
      ? `${existingHint}\n${intentHint}`
      : intentHint;

    // Special warning for PublicAccessBlock=false
    const finalHint =
      field.name === CfnKey.PUBLIC_ACCESS_BLOCK && override.value === false
        ? `${combinedHint}\nWarning: Public access will be enabled. Ensure this bucket does not contain sensitive data.`
        : combinedHint;

    const updatedQuestion = {
      ...field.question,
      initialValue: override.value,
      hint: finalHint,
    };

    // For enum fields, inject the override value as an option if not already listed
    if (
      updatedQuestion.type === "enum" &&
      typeof override.value === "string" &&
      override.value.length > 0 &&
      !(updatedQuestion.options ?? []).some(
        (o: { value: string }) => o.value === override.value,
      )
    ) {
      updatedQuestion.options = [
        {
          value: override.value as string,
          label: `${override.value} (auto-create)`,
        },
        ...(updatedQuestion.options ?? []),
      ];
    }

    return { ...field, question: updatedQuestion };
  });
}
