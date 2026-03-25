/**
 * Tag injection utilities for Assignee.ai.
 * Ensures all provisioned resources carry mandatory governance tags.
 *
 * CloudFormation tag formats differ by resource type:
 *   - Most resources (S3, IAM, etc.): Tags: [{ Key: string, Value: string }]
 *   - AWS::SSM::Parameter:            Tags: { key: value }  (flat map)
 *
 * @see Story 2-5, NFR-14
 */

/** CloudFormation tag shape used by most resource types. */
export interface CfnTag {
  Key: string;
  Value: string;
}

/** Tag keys injected on every provisioned resource (NFR-14). */
export const TAG_KEY_MANAGED_BY = "managed-by";
const TAG_KEY_RUN_ID = "assignee-run-id";
const TAG_KEY_ENVIRONMENT = "environment";

/** Tag values for the static mandatory tags. */
export const TAG_VALUE_MANAGED_BY = "assignee-ai";
const TAG_VALUE_ENVIRONMENT = "poc";

/**
 * Resource types that use a flat { key: value } map for Tags
 * instead of the standard [{ Key, Value }] array format.
 */
const FLAT_MAP_TAG_TYPES = new Set(["AWS::SSM::Parameter"]);

/**
 * Resource types that do NOT support Tags at all.
 * Tag injection is skipped entirely for these types.
 * @see AWS::EC2::Route — CloudControl rejects Tags property.
 */
const NO_TAG_TYPES = new Set(["AWS::EC2::Route"]);

/**
 * Merges mandatory Assignee.ai tags into a desiredState object.
 * Emits Tags in the correct format for the given resource type:
 *   - flat map  { key: value }         for FLAT_MAP_TAG_TYPES (e.g. SSM Parameter)
 *   - array     [{ Key, Value }]        for all other resource types
 * Mandatory tags overwrite any user-supplied tags with the same key.
 *
 * @param desiredState - The resource's desired state object
 * @param runId - Current run UUID (NFR-14 traceability)
 * @param resourceType - CloudFormation resource type (e.g. "AWS::SSM::Parameter")
 * @returns New desiredState with Tags fully merged
 */
export function injectMandatoryTags(
  desiredState: Record<string, unknown>,
  runId: string,
  resourceType?: string,
): Record<string, unknown> {
  // Skip tag injection for resource types that don't support Tags
  if (resourceType && NO_TAG_TYPES.has(resourceType)) {
    return { ...desiredState };
  }

  const mandatory: Record<string, string> = {
    [TAG_KEY_MANAGED_BY]: TAG_VALUE_MANAGED_BY,
    [TAG_KEY_RUN_ID]: runId,
    [TAG_KEY_ENVIRONMENT]: TAG_VALUE_ENVIRONMENT,
  };

  if (resourceType && FLAT_MAP_TAG_TYPES.has(resourceType)) {
    // Flat map format: { "key": "value" }
    const existingTags =
      typeof desiredState["Tags"] === "object" &&
      desiredState["Tags"] !== null &&
      !Array.isArray(desiredState["Tags"])
        ? (desiredState["Tags"] as Record<string, string>)
        : {};
    return { ...desiredState, Tags: { ...existingTags, ...mandatory } };
  }

  // Array format: [{ Key, Value }] — used by S3, IAM, and most others
  const mandatoryCfn: CfnTag[] = Object.entries(mandatory).map(
    ([Key, Value]) => ({ Key, Value }),
  );

  const existingTags = Array.isArray(desiredState["Tags"])
    ? (desiredState["Tags"] as CfnTag[])
    : [];

  // Map keyed by tag Key — mandatory tags OVERWRITE duplicates.
  const tagMap = new Map<string, string>();
  for (const tag of existingTags) tagMap.set(tag.Key, tag.Value);
  for (const tag of mandatoryCfn) tagMap.set(tag.Key, tag.Value);

  const mergedTags: CfnTag[] = Array.from(tagMap.entries()).map(
    ([Key, Value]) => ({ Key, Value }),
  );

  return { ...desiredState, Tags: mergedTags };
}
