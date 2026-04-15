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
      const { CloudWatchLogsClient, CreateLogGroupCommand } =
        await import("@aws-sdk/client-cloudwatch-logs");
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
