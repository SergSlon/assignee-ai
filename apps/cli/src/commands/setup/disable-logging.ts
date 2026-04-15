/**
 * --disable-llm-logging fast path.
 *
 * Sally UX fix: the CLI previously exposed --enable-llm-logging but no
 * symmetric --disable flag, forcing users to run raw AWS CLI commands
 * to turn logging back off. This path only touches Bedrock's
 * PutModelInvocationLoggingConfiguration — no IAM, no .env, no users.
 */

import * as clack from "@clack/prompts";
import { getPartitionFromRegion } from "@assignee/core";
import { AWS_REGION } from "../../config/constants.js";
import {
  BEDROCK_LOGGING_ROLE_NAME,
  BEDROCK_LOG_GROUP_NAME,
} from "./constants.js";
import {
  buildAdminClientConfig,
  verifyAdminCredentials,
} from "./credentials.js";

export async function runDisableLoggingFastPath(opts: {
  profile?: string | undefined;
}): Promise<void> {
  const { clientConfig } = await buildAdminClientConfig(opts.profile);
  const accountId = await verifyAdminCredentials(clientConfig, {
    contextHint: "disable-only",
  });

  const region = AWS_REGION;
  const partition = getPartitionFromRegion(region);
  const { BedrockClient, PutModelInvocationLoggingConfigurationCommand } =
    await import("@aws-sdk/client-bedrock");
  const bedrock = new BedrockClient({ ...clientConfig, region });
  const disableSp = clack.spinner();
  disableSp.start("Disabling Bedrock invocation text logging...");
  try {
    await bedrock.send(
      new PutModelInvocationLoggingConfigurationCommand({
        loggingConfig: {
          cloudWatchConfig: {
            logGroupName: BEDROCK_LOG_GROUP_NAME,
            roleArn: `arn:${partition}:iam::${accountId}:role/${BEDROCK_LOGGING_ROLE_NAME}`,
          },
          textDataDeliveryEnabled: false,
          imageDataDeliveryEnabled: false,
          embeddingDataDeliveryEnabled: false,
        },
      }),
    );
    disableSp.stop(
      "Bedrock invocation text logging — DISABLED (metadata still flows; bodies no longer captured)",
    );
  } catch (err) {
    disableSp.stop("Failed to disable Bedrock invocation logging.");
    throw err;
  }

  clack.outro(
    "LLM prompt/response text logging is OFF. Re-run with --enable-llm-logging to opt back in.",
  );
}
