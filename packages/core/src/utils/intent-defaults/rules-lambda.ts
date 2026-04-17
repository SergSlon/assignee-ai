/** Lambda function intent rules. */

import { CfnKey } from "../../config/cfn-keys.js";
import { RESOURCE_TYPES } from "../../config/resource-types/index.js";
import type { IntentRule } from "./types.js";

export const LAMBDA_RULES: IntentRule[] = [
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
];
