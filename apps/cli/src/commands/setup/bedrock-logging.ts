/**
 * Orchestrator for Bedrock invocation-logging setup. Delegates to 5
 * idempotent phase helpers under ./bedrock-logging/ (Tasks 1–4 from
 * aws-bootstrap.md + 3.5 from Story 50-5 H-2). PRIVACY:
 * textDataDeliveryEnabled defaults to FALSE; caller opts in via
 * enableLlmLogging. @see SECURITY-AUDIT.md — M-S10
 */

import * as clack from "@clack/prompts";
import type { IAMClient } from "@aws-sdk/client-iam";
import { getPartitionFromRegion } from "@assignee/core";
import { AWS_REGION } from "../../config/constants.js";
import type { AdminClientConfig } from "./credentials.js";
import { buildBedrockLoggingClients } from "./bedrock-logging/build-clients.js";
import { enableModelInvocationLogging } from "./bedrock-logging/ensure-model-invocation-logging.js";
import { ensureIamRole } from "./bedrock-logging/ensure-iam-role.js";
import { ensureInlinePolicy } from "./bedrock-logging/ensure-inline-policy.js";
import { ensureLogGroupReadRestriction } from "./bedrock-logging/ensure-log-group-read-restriction.js";
import { ensureLogGroup } from "./bedrock-logging/ensure-log-group.js";

// Pre-refactor surface re-export — external callers must not break.
export {
  BEDROCK_LOG_GROUP_RESOURCE_POLICY_NAME,
  buildBedrockLogReadRestriction,
} from "./bedrock-logging/read-restriction-policy.js";

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
  let ok = false;
  try {
    const { cwl, bedrock } = await buildBedrockLoggingClients(
      clientConfig,
      region,
    );
    await ensureIamRole(iam);
    await ensureInlinePolicy({ iam, partition, region, accountId });
    await ensureLogGroup(cwl);
    await ensureLogGroupReadRestriction({ cwl, partition, region, accountId });
    await enableModelInvocationLogging({
      bedrock,
      partition,
      accountId,
      enableLlmLogging,
    });
    ok = true;
  } finally {
    logSp.stop(
      ok
        ? "Bedrock logging IAM role and policy ready"
        : "Bedrock logging setup failed — see error above",
    );
  }
}
