/**
 * Intent rules for messaging and observability services:
 * CloudWatch alarms, SNS topics, CloudWatch log groups.
 */

import { CfnKey } from "../../config/cfn-keys.js";
import { RESOURCE_TYPES } from "../../config/resource-types/index.js";
import type { IntentRule } from "./types.js";

export const MESSAGING_LOGS_RULES: IntentRule[] = [
  // CloudWatch — Monitoring alarm (CPU)
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
];
