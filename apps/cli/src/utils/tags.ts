/**
 * Tag injection utilities for Assignee.ai.
 * Ensures all provisioned resources carry mandatory governance tags.
 *
 * CloudFormation / CCAPI tag format: [{ Key: string, Value: string }]
 * NOT a flat object — CCAPI rejects flat {key: value} maps.
 *
 * @see Story 2-5, NFR-14
 */

/** CloudFormation tag shape used by CCAPI for all resource types. */
export interface CfnTag {
  Key: string;
  Value: string;
}

/**
 * Merges mandatory Assignee.ai tags into a desiredState object.
 * Tags are produced in CloudFormation [{Key, Value}] array format.
 * Mandatory tags overwrite any user-supplied tags with the same Key.
 *
 * @param desiredState - The resource's desired state object
 * @param runId - Current run UUID (NFR-14 traceability)
 * @returns New desiredState with Tags array fully merged
 */
export function injectMandatoryTags(
  desiredState: Record<string, unknown>,
  runId: string,
): Record<string, unknown> {
  const mandatory: CfnTag[] = [
    { Key: "managed-by", Value: "assignee-ai" },
    { Key: "assignee-run-id", Value: runId },
    { Key: "environment", Value: "poc" },
  ];

  const existingTags = Array.isArray(desiredState["Tags"])
    ? (desiredState["Tags"] as CfnTag[])
    : [];

  // Map keyed by tag Key — mandatory tags OVERWRITE duplicates.
  // Without this, duplicate keys cause CloudFormation to reject the request.
  const tagMap = new Map<string, string>();
  for (const tag of existingTags) tagMap.set(tag.Key, tag.Value);
  for (const tag of mandatory) tagMap.set(tag.Key, tag.Value); // overwrites

  const mergedTags: CfnTag[] = Array.from(tagMap.entries()).map(
    ([Key, Value]) => ({ Key, Value }),
  );

  return { ...desiredState, Tags: mergedTags };
}
