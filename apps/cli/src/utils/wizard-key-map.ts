/**
 * Shared wizardKeyMap — maps BP desiredStatePatch keys to wizard field names.
 *
 * Used by fix-applicator (to check user explicit choices) and
 * fix-command-resolver (to derive --set flag commands).
 *
 * @see Story 35.1, Epic 35
 */

import { CfnKey } from "@assignee/core";

/**
 * Maps CFN patch root keys to the wizard field names that a user
 * would have set interactively via option_elicitor.
 *
 * When a BP's desiredStatePatch writes to "BlockDeviceMappings", the
 * corresponding wizard fields are "EbsEncrypted", "EbsVolumeType", etc.
 */
export const wizardKeyMap: Record<string, string[]> = {
  [CfnKey.BLOCK_DEVICE_MAPPINGS]: [
    CfnKey.EBS_ENCRYPTED,
    CfnKey.EBS_VOLUME_TYPE,
    CfnKey.EBS_VOLUME_SIZE,
  ],
  [CfnKey.METADATA_OPTIONS]: [CfnKey.HTTP_TOKENS],
  [CfnKey.PUBLIC_ACCESS_BLOCK]: [
    CfnKey.BLOCK_PUBLIC_ACLS,
    CfnKey.BLOCK_PUBLIC_POLICY,
    CfnKey.IGNORE_PUBLIC_ACLS,
    CfnKey.RESTRICT_PUBLIC_BUCKETS,
  ],
  [CfnKey.PUBLICLY_ACCESSIBLE]: [CfnKey.PUBLICLY_ACCESSIBLE],
  [CfnKey.STORAGE_ENCRYPTED]: [CfnKey.STORAGE_ENCRYPTED],
  [CfnKey.MULTI_AZ]: [CfnKey.MULTI_AZ],
  [CfnKey.DELETION_PROTECTION]: [CfnKey.DELETION_PROTECTION],
  [CfnKey.OWNERSHIP_CONTROLS]: [CfnKey.OWNERSHIP_CONTROLS],
  [CfnKey.VERSIONING_CONFIGURATION]: [CfnKey.VERSIONING_CONFIGURATION],
  [CfnKey.BUCKET_ENCRYPTION]: [
    CfnKey.BUCKET_ENCRYPTION,
    CfnKey.KMS_MASTER_KEY_ID_S3,
  ],
  [CfnKey.LIFECYCLE_CONFIGURATION]: [
    CfnKey.ENABLE_LIFECYCLE,
    CfnKey.LIFECYCLE_TRANSITION_DAYS,
    CfnKey.LIFECYCLE_EXPIRATION_DAYS,
  ],
};

/**
 * Derives a `--set` flag string from a wizardKeyMap entry.
 * Returns the first wizard field name mapped to the given patch key,
 * or null if the patch key has no wizard mapping.
 *
 * Example: toSetFlag("VersioningConfiguration") → "VersioningConfiguration"
 */
export function toSetFlag(patchKey: string): string | null {
  const fields = wizardKeyMap[patchKey];
  if (!fields || fields.length === 0) return null;
  return fields[0]!;
}

/**
 * Derives a `--set` flag by matching a patch's nested sub-key to the
 * correct wizard field. Falls back to `toSetFlag` (first field) when
 * no sub-key match is found.
 *
 * Example: toSetFlagFromPatch("PublicAccessBlockConfiguration",
 *   { PublicAccessBlockConfiguration: { BlockPublicPolicy: true } })
 *   → "BlockPublicPolicy"
 */
export function toSetFlagFromPatch(
  patchKey: string,
  patch: Record<string, unknown>,
): string | null {
  const fields = wizardKeyMap[patchKey];
  if (!fields || fields.length === 0) return null;

  // If only one field, return it
  if (fields.length === 1) return fields[0]!;

  // Look at the patch's nested keys to find which wizard field matches
  const patchValue = patch[patchKey];
  if (
    typeof patchValue === "object" &&
    patchValue !== null &&
    !Array.isArray(patchValue)
  ) {
    const nestedKeys = Object.keys(patchValue as Record<string, unknown>);
    for (const nk of nestedKeys) {
      if (fields.includes(nk)) return nk;
    }
  }

  // For array patches (e.g., BlockDeviceMappings), drill into first element
  if (Array.isArray(patchValue) && patchValue.length > 0) {
    const firstElem = patchValue[0];
    if (typeof firstElem === "object" && firstElem !== null) {
      const deepKeys = getAllLeafKeys(firstElem as Record<string, unknown>);
      for (const dk of deepKeys) {
        if (fields.includes(dk)) return dk;
      }
    }
  }

  return fields[0]!;
}

/** Collect all leaf key names from a nested object (max depth 10). */
function getAllLeafKeys(obj: Record<string, unknown>, depth = 0): string[] {
  if (depth > 10) return [];
  const keys: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      keys.push(...getAllLeafKeys(v as Record<string, unknown>, depth + 1));
    } else {
      keys.push(k);
    }
  }
  return keys;
}
