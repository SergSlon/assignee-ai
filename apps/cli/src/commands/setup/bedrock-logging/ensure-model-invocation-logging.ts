/**
 * Phase 4 of Bedrock invocation-logging setup (story 54-it1-09).
 *
 * PutModelInvocationLoggingConfiguration is idempotent — a second call
 * replaces the existing config. The caller controls the text-data
 * flag via the `enableLlmLogging` option on the public API.
 *
 * PRIVACY: textDataDeliveryEnabled defaults to false unless the caller
 * explicitly opts in. When text logging is enabled the user receives a
 * warning pointing at the AWS CLI command to disable it later.
 */

import * as clack from "@clack/prompts";
import type { BedrockClient } from "@aws-sdk/client-bedrock";
import { buildIamRoleArn } from "../../../utils/setup-arn-builder.js";
import {
  BEDROCK_LOG_GROUP_NAME,
  BEDROCK_LOGGING_ROLE_NAME,
} from "../constants.js";

/**
 * Enable Bedrock model invocation logging. Prints a privacy warning
 * if `enableLlmLogging` is true. Partition-aware ARN construction.
 */
export async function enableModelInvocationLogging(opts: {
  bedrock: BedrockClient;
  partition: string;
  accountId: string;
  enableLlmLogging: boolean;
}): Promise<void> {
  const { bedrock, partition, accountId, enableLlmLogging } = opts;
  const { PutModelInvocationLoggingConfigurationCommand } =
    await import("@aws-sdk/client-bedrock");
  const textLogging = enableLlmLogging === true;
  const roleArn = buildIamRoleArn({
    partition,
    accountId,
    roleName: BEDROCK_LOGGING_ROLE_NAME,
  });
  if (textLogging) {
    clack.log.warn(
      "⚠ All LLM prompts/responses will be logged to CloudWatch — " +
        `disable later via: aws bedrock put-model-invocation-logging-configuration ` +
        `--logging-config '{"cloudWatchConfig":{"logGroupName":"${BEDROCK_LOG_GROUP_NAME}","roleArn":"${roleArn}"},"textDataDeliveryEnabled":false}'`,
    );
  }
  await bedrock.send(
    new PutModelInvocationLoggingConfigurationCommand({
      loggingConfig: {
        cloudWatchConfig: {
          logGroupName: BEDROCK_LOG_GROUP_NAME,
          roleArn,
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
