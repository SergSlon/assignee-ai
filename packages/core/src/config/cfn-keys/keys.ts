/**
 * Merged `CfnKey` map — composed from per-area shards.
 * Preserves the public surface that used to live in the monolithic
 * `cfn-keys.ts` file.
 *
 * @see Story 42.9 / 42.10
 */

import { CFN_KEYS_CORE } from "./keys-core.js";
import { CFN_KEYS_SERVICES } from "./keys-services.js";
import { CFN_KEYS_WIZARD } from "./keys-wizard.js";

export const CfnKey = {
  ...CFN_KEYS_CORE,
  ...CFN_KEYS_SERVICES,
  ...CFN_KEYS_WIZARD,
} as const;

export type CfnKeyType = (typeof CfnKey)[keyof typeof CfnKey];

/**
 * Sentinel value used by plan_generator to defer EIP allocation to apply time.
 * resource_provisioner replaces this with a real AllocationId at provision time.
 */
export const EIP_AUTO_ALLOCATE = "AUTO_ALLOCATE_EIP" as const;

/**
 * Tag key/value pair used to mark resources as managed by Assignee.ai.
 * Use instead of raw "managed-by" / "assignee-ai" strings.
 */
export const AssigneeTag = {
  KEY: "managed-by",
  VALUE: "assignee-ai",
} as const;
