/**
 * Barrel + implementation of `getRequiredIamActions()` — the public
 * surface previously owned by `config/iam-actions.ts`.
 *
 * Maps CloudFormation resource types to the IAM actions required
 * for CloudControl API provisioning + service-specific bootstrapping.
 *
 * @see Story 19.1 — IAM MCP Server Integration (FR-43)
 */

import { CCAPI_BASE_ACTIONS } from "./ccapi.js";
import { SERVICE_ACTION_MAP } from "./service-map.js";

/**
 * Returns the IAM actions required to provision a given CloudFormation resource type.
 * Includes both CloudControl API base actions and service-specific actions.
 */
export function getRequiredIamActions(resourceType: string): string[] {
  const serviceActions = SERVICE_ACTION_MAP[resourceType] ?? [];
  return [...CCAPI_BASE_ACTIONS, ...serviceActions];
}

export { CCAPI_BASE_ACTIONS, SERVICE_ACTION_MAP };
