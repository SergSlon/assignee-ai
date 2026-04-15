/**
 * IAM actions for messaging + eventing resource types:
 * SQS, SNS (Topic + Subscription), EventBridge (Rule, EventBus,
 * Connection, ApiDestination).
 *
 * Split out of `iam-actions.ts` for SRP.
 */

import { RESOURCE_TYPES } from "../resource-types.js";

export const MESSAGING_ACTIONS: Record<string, string[]> = {
  [RESOURCE_TYPES.SQS_QUEUE]: [
    "sqs:CreateQueue",
    "sqs:DeleteQueue",
    "sqs:GetQueueAttributes",
    "sqs:SetQueueAttributes",
    "sqs:GetQueueUrl",
    "sqs:TagQueue",
    "sqs:ListQueueTags",
  ],
  [RESOURCE_TYPES.SNS_TOPIC]: [
    "sns:CreateTopic",
    "sns:DeleteTopic",
    "sns:GetTopicAttributes",
    "sns:SetTopicAttributes",
    "sns:TagResource",
    "sns:ListTagsForResource",
  ],
  // A10 (2026-04-09): AWS::SNS::Subscription.
  [RESOURCE_TYPES.SNS_SUBSCRIPTION]: [
    "sns:Subscribe",
    "sns:Unsubscribe",
    "sns:GetSubscriptionAttributes",
    "sns:SetSubscriptionAttributes",
    "sns:ListSubscriptions",
    "sns:ListSubscriptionsByTopic",
    "iam:GetRole",
    "iam:PassRole",
  ],
  // A8 (2026-04-08): EventBridge Rule first-class.
  [RESOURCE_TYPES.EVENTS_RULE]: [
    "events:PutRule",
    "events:DeleteRule",
    "events:DescribeRule",
    "events:PutTargets",
    "events:RemoveTargets",
    "events:TagResource",
  ],
  // A9 (2026-04-09): Events::EventBus.
  [RESOURCE_TYPES.EVENTS_EVENT_BUS]: [
    "events:CreateEventBus",
    "events:DeleteEventBus",
    "events:DescribeEventBus",
    "events:ListEventBuses",
    "events:PutPermission",
    "events:RemovePermission",
    "events:TagResource",
  ],
  // A12 (2026-04-09): Events::Connection.
  [RESOURCE_TYPES.EVENTS_CONNECTION]: [
    "events:CreateConnection",
    "events:UpdateConnection",
    "events:DeleteConnection",
    "events:DescribeConnection",
    "events:ListConnections",
    "iam:CreateServiceLinkedRole",
  ],
  // A13 (2026-04-09): Events::ApiDestination.
  [RESOURCE_TYPES.EVENTS_API_DESTINATION]: [
    "events:CreateApiDestination",
    "events:UpdateApiDestination",
    "events:DeleteApiDestination",
    "events:DescribeApiDestination",
    "events:ListApiDestinations",
  ],
};
