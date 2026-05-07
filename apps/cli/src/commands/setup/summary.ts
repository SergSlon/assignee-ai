/**
 * Writes the resolved access keys to .env (idempotent merge) and prints
 * the final per-role summary.
 *
 * SECURITY: access keys are NEVER logged to stdout verbatim — only the
 * env-var names and user-to-policy mapping. The secret values hit disk
 * via mergeEnvFile and stay there.
 */

import * as path from "node:path";
import * as clack from "@clack/prompts";
import { mergeEnvFile } from "../../utils/env-writer.js";
import { ROLES } from "./constants.js";

export function writeEnvAndSummary(envUpdates: Record<string, string>): void {
  if (Object.keys(envUpdates).length > 0) {
    const envPath = path.resolve(process.cwd(), ".env");
    const sp = clack.spinner();
    sp.start("Writing credentials to .env...");
    mergeEnvFile(envPath, envUpdates);
    sp.stop("Credentials written to .env");
  } else {
    clack.log.info("No new access keys created — .env file unchanged.");
  }

  clack.log.success("IAM setup complete! Users and policies:");
  for (const role of ROLES) {
    const policyList = role.policies.map((p) => p.name).join(", ");
    clack.log.step(
      `  ${role.userName} → ${policyList} (env: ${role.envKeyId})`,
    );
  }

  clack.outro("Run `assignee plan` to verify the new credentials work.");
  clack.log.info(
    "ℹ Subsequent assignee commands in this shell will pick up the new\n" +
      "  credentials automatically (.env is auto-loaded at CLI startup).\n" +
      "  No need to run `source .env` manually.",
  );
}

export function printInteractivePlan(): void {
  clack.log.info(
    "This command will create/update the following IAM resources:",
  );
  for (const role of ROLES) {
    const policyList = role.policies.map((p) => p.name).join(", ");
    clack.log.step(
      `  User: ${role.userName}\n  Policy: ${policyList}\n  Purpose: ${role.description}`,
    );
  }
}
