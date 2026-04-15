/**
 * Aggregates "miscellaneous" (non-EC2/S3/Lambda/RDS) intent rules, grouped
 * into cohesive sub-files: data services (DynamoDB/SQS/SecretsManager/SSM),
 * messaging/logs (CloudWatch/SNS/Logs), and compute/network (IAM/ECS/ECR/ELBv2/APIGW).
 */

import type { IntentRule } from "./types.js";
import { DATA_SERVICE_RULES } from "./rules-data-services.js";
import { MESSAGING_LOGS_RULES } from "./rules-messaging-logs.js";
import { COMPUTE_NETWORK_RULES } from "./rules-compute-network.js";

export const MISC_RULES: IntentRule[] = [
  ...DATA_SERVICE_RULES,
  ...MESSAGING_LOGS_RULES,
  ...COMPUTE_NETWORK_RULES,
];
