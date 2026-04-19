import { RESOURCE_TYPES } from "@/config/resource-types.js";
import type { ResourcePlugin } from "../../types.js";
import { commonFields, advancedFields } from "./fields.js";
import { defaults, configHints } from "./config.js";

export * from "./trust-policy.js";
export { commonFields, advancedFields, defaults, configHints };

/**
 * ResourcePlugin for AWS::IAM::Role.
 * Provides enum-based trust policy selection and managed policy attachment.
 * SECURITY: Never creates roles with AdministratorAccess (see AGENTS.md).
 */
export const iamRolePlugin: ResourcePlugin = {
  resourceType: RESOURCE_TYPES.IAM_ROLE,
  commonFields,
  advancedFields,
  defaults,
  configHints,
};
