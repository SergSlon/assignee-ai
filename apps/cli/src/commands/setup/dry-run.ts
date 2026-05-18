/**
 * Dry-run plan printer for `assignee dev setup`.
 *
 * INVARIANT (tested): dry-run MUST make ZERO AWS calls. This module is
 * pure — it only writes to clack.log. No IAMClient, STSClient, Bedrock,
 * or CWL imports on purpose.
 *
 * UX (M-T1): Each section is rendered as ONE multi-line clack.log.step
 * call so clack inserts only one `│` connector per section.
 */

import * as clack from "@clack/prompts";
import {
  ROLES,
  BEDROCK_LOGGING_ROLE_NAME,
  BEDROCK_LOGGING_POLICY_NAME,
  BEDROCK_LOG_GROUP_NAME,
} from "./constants.js";

/** Full-setup dry-run plan. */
export function printSetupDryRun(opts: { enableLlmLogging: boolean }): void {
  clack.log.info(
    "DRY RUN — no AWS APIs will be called. The following resources WOULD be created/updated:",
  );
  clack.log.step(
    "IAM Users:\n" +
      ROLES.map(
        (r) =>
          `  - ${r.userName} (managed policies: ${r.policies.map((p) => p.name).join(", ")}) — ${r.description}`,
      ).join("\n"),
  );
  clack.log.step(
    "IAM Managed Policies:\n" +
      ROLES.flatMap((r) =>
        r.policies.map((p) => `  - ${p.name} (attached to user ${r.userName})`),
      ).join("\n"),
  );
  clack.log.step(
    "IAM Access Keys:\n" +
      ROLES.map(
        (r) =>
          `  - 1 access key per user, written to .env as ${r.envKeyId} / ${r.envSecretKey}`,
      ).join("\n"),
  );
  const textLogging = opts.enableLlmLogging ? "true" : "false";
  clack.log.step(
    "Bedrock invocation logging infrastructure:\n" +
      `  - IAM role: ${BEDROCK_LOGGING_ROLE_NAME}\n` +
      `  - Inline policy: ${BEDROCK_LOGGING_POLICY_NAME} (logs:CreateLogGroup, CreateLogStream, PutLogEvents, DescribeLogGroups)\n` +
      `  - CloudWatch log group: ${BEDROCK_LOG_GROUP_NAME}\n` +
      `  - Bedrock model invocation logging configuration: textDataDeliveryEnabled=${textLogging}, imageDataDeliveryEnabled=false, embeddingDataDeliveryEnabled=false`,
  );
  if (opts.enableLlmLogging) {
    clack.log.warn(
      "WARNING: --enable-llm-logging is set. If applied, ALL Bedrock prompts and responses will be written to CloudWatch Logs in plaintext.",
    );
  } else {
    clack.log.info(
      "LLM prompt/response text logging is OFF (safe default). Re-run with --enable-llm-logging to opt in.",
    );
  }
  clack.log.step(`Files written: .env (in ${process.cwd()})`);
  clack.outro("Dry run complete — no changes made.");
}

/** --disable-llm-logging --dry-run plan. */
export function printDisableLoggingDryRun(): void {
  clack.log.info(
    "DRY RUN — no AWS APIs will be called. The following Bedrock configuration WOULD be applied:",
  );
  clack.log.step(
    "Bedrock invocation logging — DISABLE:\n" +
      `  - Target log group: ${BEDROCK_LOG_GROUP_NAME}\n` +
      `  - Target role: ${BEDROCK_LOGGING_ROLE_NAME}\n` +
      `  - textDataDeliveryEnabled: false\n` +
      `  - imageDataDeliveryEnabled: false\n` +
      `  - embeddingDataDeliveryEnabled: false`,
  );
  clack.outro(
    "Dry run complete — no changes made. Re-run without --dry-run to apply.",
  );
}
