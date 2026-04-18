/**
 * Phase 3.5 of Bedrock invocation-logging setup (Story 50-5 H-2,
 * preserved through story 54-it1-09).
 *
 * PutResourcePolicy is idempotent — AWS overwrites by policyName,
 * which matches the "idempotent reapply on setup re-run" requirement
 * in the original story spec.
 *
 * Restricts read access on the Bedrock log group to the operator user
 * and the account root, preventing other principals from tailing
 * prompt/response text via `logs:GetLogEvents` / `FilterLogEvents` /
 * `StartQuery`.
 */

import * as clack from "@clack/prompts";
import type { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import {
  BEDROCK_LOG_GROUP_RESOURCE_POLICY_NAME,
  buildBedrockLogReadRestriction,
} from "./read-restriction-policy.js";

/**
 * Apply the log-group read-restriction resource policy. Idempotent
 * reapply on setup re-run — AWS overwrites by policyName.
 */
export async function ensureLogGroupReadRestriction(opts: {
  cwl: CloudWatchLogsClient;
  partition: string;
  region: string;
  accountId: string;
}): Promise<void> {
  const { cwl, partition, region, accountId } = opts;
  const { PutResourcePolicyCommand } =
    await import("@aws-sdk/client-cloudwatch-logs");
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
