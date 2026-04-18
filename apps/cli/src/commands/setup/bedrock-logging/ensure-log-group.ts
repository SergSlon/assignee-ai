/**
 * Phase 3 of Bedrock invocation-logging setup (story 54-it1-09).
 *
 * Idempotent: CreateLogGroup → catch RESOURCE_ALREADY_EXISTS → verified.
 * Uses dependency injection for the CloudWatchLogsClient (not
 * constructed here) so the orchestrator controls client lifecycle.
 */

import * as clack from "@clack/prompts";
import type { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { AwsErrorName } from "../../../constants/aws-errors.js";
import { BEDROCK_LOG_GROUP_NAME } from "../constants.js";

/**
 * Get-or-create the CloudWatch log group that stores Bedrock
 * invocation records. RESOURCE_ALREADY_EXISTS is the documented
 * AWS error name for "this name is already taken" — treat as success.
 */
export async function ensureLogGroup(cwl: CloudWatchLogsClient): Promise<void> {
  const { CreateLogGroupCommand } =
    await import("@aws-sdk/client-cloudwatch-logs");
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
