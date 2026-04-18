/**
 * CloudWatch Logs resource-policy builder (Story 50-5 H-2).
 *
 * Extracted from the main bedrock-logging module in story 54-it1-09 so
 * the Phase 3.5 helper can import the builder without creating a
 * circular dependency back through the orchestrator.
 *
 * Least-privilege read surface:
 *   - `arn:<partition>:iam::<account>:user/assignee-operator` — the
 *     sole CLI principal that needs to tail these logs.
 *   - `arn:<partition>:iam::<account>:root` — AWS best-practice
 *     escape hatch so the account owner can never be locked out
 *     of their own log group.
 *
 * All other principals are denied `logs:GetLogEvents` +
 * `logs:FilterLogEvents` + `logs:StartQuery` (the three read actions
 * that can leak prompt/response text). Writes (CreateLogStream /
 * PutLogEvents) are handled by the separate IAM role policy.
 */

import { IAM_USER_NAMES, IamEffect, IamPolicy } from "@assignee/core";
import { BEDROCK_LOG_GROUP_NAME } from "../constants.js";

/**
 * Name of the Bedrock log-group resource-policy created in Task 3.5.
 * Matches the `AssigneeAi*` naming convention for discoverability.
 */
export const BEDROCK_LOG_GROUP_RESOURCE_POLICY_NAME =
  "AssigneeAiBedrockLoggingReadRestriction";

/**
 * Builds the CloudWatch Logs resource policy JSON that restricts read
 * access to the Bedrock invocation log group.
 */
export function buildBedrockLogReadRestriction(opts: {
  partition: string;
  accountId: string;
  region: string;
}): string {
  const { partition, accountId, region } = opts;
  const logGroupArn = `arn:${partition}:logs:${region}:${accountId}:log-group:${BEDROCK_LOG_GROUP_NAME}:*`;
  const operatorUserArn = `arn:${partition}:iam::${accountId}:user/${IAM_USER_NAMES.operator}`;
  const rootArn = `arn:${partition}:iam::${accountId}:root`;
  return JSON.stringify({
    Version: IamPolicy.VERSION,
    Statement: [
      {
        Sid: "DenyBedrockLogReadExceptOperatorAndRoot",
        Effect: IamEffect.DENY,
        Principal: "*",
        Action: [
          "logs:GetLogEvents",
          "logs:FilterLogEvents",
          "logs:StartQuery",
        ],
        Resource: logGroupArn,
        Condition: {
          StringNotEquals: {
            "aws:PrincipalArn": [operatorUserArn, rootArn],
          },
        },
      },
    ],
  });
}
