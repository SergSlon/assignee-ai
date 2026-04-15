/**
 * IAM actions for observability / monitoring resource types:
 * CloudWatch Alarm + CloudWatch Logs LogGroup, SSM Parameter.
 *
 * Split out of `iam-actions.ts` for SRP.
 */

import { RESOURCE_TYPES } from "../resource-types.js";

export const OBSERVABILITY_ACTIONS: Record<string, string[]> = {
  [RESOURCE_TYPES.LOGS_LOG_GROUP]: [
    "logs:CreateLogGroup",
    "logs:DeleteLogGroup",
    "logs:DescribeLogGroups",
    "logs:PutRetentionPolicy",
    "logs:TagLogGroup",
    "logs:ListTagsLogGroup",
  ],
  [RESOURCE_TYPES.CLOUDWATCH_ALARM]: [
    "cloudwatch:PutMetricAlarm",
    "cloudwatch:DeleteAlarms",
    "cloudwatch:DescribeAlarms",
    "cloudwatch:SetAlarmState",
    "cloudwatch:TagResource",
    "cloudwatch:EnableAlarmActions",
    "cloudwatch:DisableAlarmActions",
  ],
  [RESOURCE_TYPES.SSM_PARAMETER]: [
    "ssm:PutParameter",
    "ssm:GetParameter",
    "ssm:GetParameters",
    "ssm:GetParametersByPath", // E2E sweeper + bulk list by prefix
    "ssm:DescribeParameters", // E2E sweeper fallback
    "ssm:DeleteParameter",
    "ssm:AddTagsToResource",
    "ssm:ListTagsForResource",
  ],
};
