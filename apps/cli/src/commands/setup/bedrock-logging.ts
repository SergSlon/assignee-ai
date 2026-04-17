/**
 * Sets up Bedrock invocation-logging infrastructure (Tasks 1–4 from
 * aws-bootstrap.md):
 *   1. Create/verify AssigneeAiBedrockLoggingRole (trusts bedrock.amazonaws.com)
 *   2. PutRolePolicy (logs:CreateLogGroup / CreateLogStream / PutLogEvents / DescribeLogGroups)
 *   3. Create CloudWatch log group /assignee-ai/bedrock-invocations
 *   4. PutModelInvocationLoggingConfiguration
 *
 * PRIVACY: textDataDeliveryEnabled defaults to FALSE. Only when the
 * caller explicitly passes `enableLlmLogging=true` do we send
 * prompt/response text to CloudWatch Logs.
 *
 * Wrapped in try/finally so any throw stops the spinner cleanly.
 * @see SECURITY-AUDIT.md — M-S10
 */

import * as clack from "@clack/prompts";
import {
  type IAMClient,
  CreateRoleCommand,
  GetRoleCommand,
  PutRolePolicyCommand,
  TagRoleCommand,
} from "@aws-sdk/client-iam";
import {
  IAM_USER_NAMES,
  IamAction,
  IamEffect,
  IamPolicy,
  AwsServicePrincipal,
  getPartitionFromRegion,
} from "@assignee/core";
import { AWS_REGION } from "../../config/constants.js";
import { AwsErrorName } from "../../constants/aws-errors.js";
import {
  BEDROCK_LOG_GROUP_NAME,
  BEDROCK_LOGGING_POLICY_NAME,
  BEDROCK_LOGGING_ROLE_NAME,
  MANAGED_TAG,
} from "./constants.js";
import type { AdminClientConfig } from "./credentials.js";

/**
 * Name of the Bedrock log-group resource-policy created in Task 3.5.
 * Matching the `AssigneeAi*` naming convention for discoverability.
 */
export const BEDROCK_LOG_GROUP_RESOURCE_POLICY_NAME =
  "AssigneeAiBedrockLoggingReadRestriction";

/**
 * Builds the CloudWatch Logs resource policy JSON that restricts read
 * access to the Bedrock invocation log group. Story 50-5 H-2.
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

export async function setupBedrockLogging(opts: {
  iam: IAMClient;
  clientConfig: AdminClientConfig;
  accountId: string;
  enableLlmLogging: boolean;
}): Promise<void> {
  const { iam, clientConfig, accountId, enableLlmLogging } = opts;
  const region = AWS_REGION;
  const partition = getPartitionFromRegion(region);

  const logSp = clack.spinner();
  logSp.start("Setting up Bedrock invocation logging...");
  let bedrockLoggingOk = false;
  try {
    // Task 1: IAM role for Bedrock logging
    try {
      await iam.send(
        new GetRoleCommand({ RoleName: BEDROCK_LOGGING_ROLE_NAME }),
      );
      clack.log.step(
        `Role ${BEDROCK_LOGGING_ROLE_NAME} — verified (already exists)`,
      );
    } catch (err: unknown) {
      if (err instanceof Error && err.name === AwsErrorName.NO_SUCH_ENTITY) {
        await iam.send(
          new CreateRoleCommand({
            RoleName: BEDROCK_LOGGING_ROLE_NAME,
            AssumeRolePolicyDocument: JSON.stringify({
              Version: IamPolicy.VERSION,
              Statement: [
                {
                  Effect: IamEffect.ALLOW,
                  Principal: { Service: AwsServicePrincipal.BEDROCK },
                  Action: IamPolicy.ACTION_ASSUME_ROLE,
                },
              ],
            }),
            Description:
              "Allows Bedrock to write invocation logs to CloudWatch",
          }),
        );
        clack.log.step(`Role ${BEDROCK_LOGGING_ROLE_NAME} — created`);
      } else {
        throw err;
      }
    }

    // Tag Bedrock logging role idempotently
    await iam.send(
      new TagRoleCommand({
        RoleName: BEDROCK_LOGGING_ROLE_NAME,
        Tags: [MANAGED_TAG],
      }),
    );

    // Task 2: Inline logging policy (put-role-policy is idempotent)
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
              Resource: `arn:${partition}:logs:${region}:${accountId}:log-group:${BEDROCK_LOG_GROUP_NAME}:*`,
            },
          ],
        }),
      }),
    );
    clack.log.step("Inline policy BedrockLoggingPolicy — applied");

    // Task 3: CloudWatch log group
    {
      const {
        CloudWatchLogsClient,
        CreateLogGroupCommand,
        PutResourcePolicyCommand,
      } = await import("@aws-sdk/client-cloudwatch-logs");
      const cwl = new CloudWatchLogsClient({ ...clientConfig, region });
      try {
        await cwl.send(
          new CreateLogGroupCommand({ logGroupName: BEDROCK_LOG_GROUP_NAME }),
        );
        clack.log.step(`Log group ${BEDROCK_LOG_GROUP_NAME} — created`);
      } catch (err: unknown) {
        if (
          err instanceof Error &&
          err.name === AwsErrorName.RESOURCE_ALREADY_EXISTS
        ) {
          clack.log.step(`Log group ${BEDROCK_LOG_GROUP_NAME} — verified`);
        } else {
          throw err;
        }
      }

      // Task 3.5 (Story 50-5 H-2): restrict who can read the Bedrock
      // invocation log group. PutResourcePolicy is idempotent — AWS
      // overwrites by policyName, matching the "idempotent reapply on
      // setup re-run" requirement in the story spec.
      await cwl.send(
        new PutResourcePolicyCommand({
          policyName: BEDROCK_LOG_GROUP_RESOURCE_POLICY_NAME,
          policyDocument: buildBedrockLogReadRestriction({
            partition,
            accountId,
            region,
          }),
        }),
      );
      clack.log.step(
        `Log group read-restriction policy ${BEDROCK_LOG_GROUP_RESOURCE_POLICY_NAME} — applied`,
      );
    }

    // Task 4: PutModelInvocationLoggingConfiguration
    {
      const { BedrockClient, PutModelInvocationLoggingConfigurationCommand } =
        await import("@aws-sdk/client-bedrock");
      const bedrock = new BedrockClient({ ...clientConfig, region });
      const textLogging = enableLlmLogging === true;
      if (textLogging) {
        clack.log.warn(
          "⚠ All LLM prompts/responses will be logged to CloudWatch — " +
            `disable later via: aws bedrock put-model-invocation-logging-configuration ` +
            `--logging-config '{"cloudWatchConfig":{"logGroupName":"${BEDROCK_LOG_GROUP_NAME}","roleArn":"arn:${partition}:iam::${accountId}:role/${BEDROCK_LOGGING_ROLE_NAME}"},"textDataDeliveryEnabled":false}'`,
        );
      }
      await bedrock.send(
        new PutModelInvocationLoggingConfigurationCommand({
          loggingConfig: {
            cloudWatchConfig: {
              logGroupName: BEDROCK_LOG_GROUP_NAME,
              roleArn: `arn:${partition}:iam::${accountId}:role/${BEDROCK_LOGGING_ROLE_NAME}`,
            },
            textDataDeliveryEnabled: textLogging,
            imageDataDeliveryEnabled: false,
            embeddingDataDeliveryEnabled: false,
          },
        }),
      );
      clack.log.step(
        textLogging
          ? "Bedrock invocation logging — enabled (text bodies INCLUDED)"
          : "Bedrock invocation logging — enabled (metadata only, text bodies excluded)",
      );
    }

    bedrockLoggingOk = true;
  } finally {
    logSp.stop(
      bedrockLoggingOk
        ? "Bedrock logging IAM role and policy ready"
        : "Bedrock logging setup failed — see error above",
    );
  }
}
