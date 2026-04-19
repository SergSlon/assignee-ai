/**
 * Phase 2 of Bedrock invocation-logging setup (story 54-it1-09).
 *
 * Idempotent by nature — IAM PutRolePolicy overwrites any existing
 * inline policy with the same name under the same role.
 *
 * Grants the minimum CloudWatch Logs actions required for Bedrock to
 * write invocation records to the dedicated log group (scoped by ARN
 * to prevent cross-group writes).
 */

import * as clack from "@clack/prompts";
import { type IAMClient, PutRolePolicyCommand } from "@aws-sdk/client-iam";
import { IamAction, IamEffect, IamPolicy } from "@assignee/core";
import { buildLogGroupArn } from "../../../utils/setup-arn-builder.js";
import {
  BEDROCK_LOG_GROUP_NAME,
  BEDROCK_LOGGING_POLICY_NAME,
  BEDROCK_LOGGING_ROLE_NAME,
} from "../constants.js";

/**
 * Apply the Bedrock logging inline policy — idempotent: AWS overwrites
 * by (RoleName, PolicyName). The resource ARN is partition-aware
 * (`arn:<partition>:...`) per feedback_partition_aware_arn_matching.
 */
export async function ensureInlinePolicy(opts: {
  iam: IAMClient;
  partition: string;
  region: string;
  accountId: string;
}): Promise<void> {
  const { iam, partition, region, accountId } = opts;
  await iam.send(
    new PutRolePolicyCommand({
      RoleName: BEDROCK_LOGGING_ROLE_NAME,
      PolicyName: BEDROCK_LOGGING_POLICY_NAME,
      PolicyDocument: JSON.stringify({
        Version: IamPolicy.VERSION,
        Statement: [
          {
            Effect: IamEffect.ALLOW,
            Action: [
              IamAction.LOGS_CREATE_LOG_GROUP,
              IamAction.LOGS_CREATE_LOG_STREAM,
              IamAction.LOGS_PUT_LOG_EVENTS,
              IamAction.LOGS_DESCRIBE_LOG_GROUPS,
            ],
            Resource: buildLogGroupArn({
              partition,
              region,
              accountId,
              logGroupName: BEDROCK_LOG_GROUP_NAME,
            }),
          },
        ],
      }),
    }),
  );
  clack.log.step("Inline policy BedrockLoggingPolicy — applied");
}
