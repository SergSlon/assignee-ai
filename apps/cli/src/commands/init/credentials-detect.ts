/**
 * Detects which Assignee IAM roles have credentials configured via environment.
 *
 * @see SECURITY-AUDIT.md — M-S8
 */

import {
  ASSIGNEE_ROLES,
  envVarsForRole,
  type AssigneeRole,
} from "@assignee/core";

/**
 * Delegates to `@assignee/core` (envVarsForRole) for the role → env var
 * mapping so there is exactly one source of truth across the monorepo.
 *
 * Each role pair must have BOTH access key id AND secret access key set
 * (non-empty after trim) to be considered available.
 */
export function detectAvailableRoles(
  env: NodeJS.ProcessEnv = process.env,
): AssigneeRole[] {
  const available: AssigneeRole[] = [];
  for (const role of ASSIGNEE_ROLES) {
    const { accessKey, secretKey } = envVarsForRole(role);
    const id = env[accessKey]?.trim();
    const secret = env[secretKey]?.trim();
    if (id && secret) {
      available.push(role);
    }
  }
  return available;
}
