/**
 * RDS credentials advisory (RG-1 / DF-E5 — Solution C).
 *
 * Emits advisory code RDS_MASTER_USER_PASSWORD_REQUIRED when an
 * AWS::RDS::DBInstance plan contains the actionable placeholder sentinel for
 * MasterUserPassword, pointing the user to --set or the deferred SecretsManager
 * compound (Solutions A and B are roadmap items per spec line 16).
 *
 * Guard: only fires for AWS::RDS::DBInstance.
 */

import { RESOURCE_TYPES, CfnKey } from "@/index.js";
import { RDS_REQUIRED_PASSWORD_PLACEHOLDER } from "@/config/placeholder-passwords.js";
import { AdviceIcon } from "./constants.js";

export const RDS_MASTER_USER_PASSWORD_REQUIRED =
  "RDS_MASTER_USER_PASSWORD_REQUIRED";

/**
 * Returns an advisory string array (0 or 1 element) when an RDS DBInstance
 * plan still carries the placeholder MasterUserPassword.
 */
export function rdsCredentialsHint(
  resourceType: string,
  desiredState: Record<string, unknown>,
): string[] {
  if (resourceType !== RESOURCE_TYPES.RDS_DB_INSTANCE) return [];

  const pw = desiredState[CfnKey.MASTER_USER_PASSWORD];
  if (pw !== RDS_REQUIRED_PASSWORD_PLACEHOLDER) return [];

  return [
    `${AdviceIcon.WARNING} [${RDS_MASTER_USER_PASSWORD_REQUIRED}] ` +
      `MasterUserPassword is required for RDS. ` +
      `Pass it with --set MasterUserPassword=<your-password> when running "assignee plan". ` +
      `Roadmap: Solutions A (SecretsManager dynamic-reference compound) and ` +
      `B (locally-generated random + no-echo) are deferred to follow-up stories.`,
  ];
}
