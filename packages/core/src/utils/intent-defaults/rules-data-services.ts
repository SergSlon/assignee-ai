/**
 * Intent rules for data-oriented services:
 * DynamoDB, SQS, SecretsManager, SSM Parameter.
 */

import { CfnKey } from "../../config/cfn-keys.js";
import { RESOURCE_TYPES } from "../../config/resource-types/index.js";
import type { IntentRule } from "./types.js";

export const DATA_SERVICE_RULES: IntentRule[] = [
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
];
