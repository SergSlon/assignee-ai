/**
 * Tag injection utilities for Assignee.ai.
 * Ensures all provisioned resources carry mandatory governance tags.
 *
 * CloudFormation tag formats differ by resource type:
 *   - Most resources (S3, IAM, etc.): Tags: [{ Key: string, Value: string }]
 *   - SSM Parameter:                  Tags: { key: value }  (flat map)
 *
 * @see Story 2-5, NFR-14
 */

import { RESOURCE_TYPES, CfnKey, AssigneeTag } from "@assignee/core";

/** CloudFormation tag shape used by most resource types. */
export interface CfnTag {
  Key: string;
  Value: string;
}

/** Tag keys injected on every provisioned resource (NFR-14). */
export const TAG_KEY_MANAGED_BY = AssigneeTag.KEY;
const TAG_KEY_RUN_ID = "assignee-run-id";
const TAG_KEY_ENVIRONMENT = "environment";

/** Tag values for the static mandatory tags. */
export const TAG_VALUE_MANAGED_BY = AssigneeTag.VALUE;
const TAG_VALUE_ENVIRONMENT = "poc";

/**
 * Resource types that use a flat { key: value } map for Tags
 * instead of the standard [{ Key, Value }] array format.
 */
const FLAT_MAP_TAG_TYPES: Set<string> = new Set([RESOURCE_TYPES.SSM_PARAMETER]);

/**
 * Resource types whose CCAPI schema uses a tag property name other than "Tags".
 * When listed here, injectMandatoryTags writes the merged tag array to the
 * mapped property name instead of `CfnKey.TAGS` and refuses to leave a stray
 * top-level "Tags" property behind (EFS rejects it with `extraneous key [Tags]
 * is not permitted`). Values must still use the standard
 * [{ Key, Value }] array shape.
 *
 * 2026-04-11 fix for efs-with-vpc nightly failure: the EFS plugin's own
 * configHints (efs-file-system.ts:236) explicitly document that EFS has NO
 * top-level Tags property — "FileSystemTags" is the correct key. The
 * compound-flow traceability tag injection previously wrote Tags anyway,
 * causing CCAPI schema rejection the moment the efs-with-vpc compound
 * reached its EFS::FileSystem resource.
 */
const ALTERNATE_TAG_KEY_TYPES: ReadonlyMap<string, string> = new Map([
  [RESOURCE_TYPES.EFS_FILE_SYSTEM, "FileSystemTags"],
]);

/**
 * Resource types that do NOT support Tags at all.
 * Tag injection is skipped entirely for these types.
 * @see AWS::EC2::Route — CloudControl rejects Tags property.
 */
const NO_TAG_TYPES: Set<string> = new Set([
  RESOURCE_TYPES.EC2_ROUTE,
  // WV4-A: Cross-reference resources don't accept Tags in CloudFormation
  RESOURCE_TYPES.EC2_VPC_GATEWAY_ATTACHMENT,
  RESOURCE_TYPES.EC2_SUBNET_ROUTE_TABLE_ASSOCIATION,
  // A10 (2026-04-09): AWS::SNS::Subscription — CCAPI schema reports
  // tagging.taggable=false. Injecting Tags causes CCAPI to reject
  // the create/update with a "Properties validation failed" error.
  RESOURCE_TYPES.SNS_SUBSCRIPTION,
  // A12 (2026-04-09): AWS::Events::Connection — tagging.taggable=false
  // in the CCAPI schema. Auth credentials live in a managed Secrets
  // Manager secret which IS taggable, but the Connection itself
  // isn't.
  RESOURCE_TYPES.EVENTS_CONNECTION,
  // A13 (2026-04-09): AWS::Events::ApiDestination — also
  // tagging.taggable=false per the CCAPI schema.
  RESOURCE_TYPES.EVENTS_API_DESTINATION,
  // (f) 2026-04-09 Task 4b: AWS::CloudFront::OriginAccessControl —
  // tagging.taggable=false (OAC is a CloudFront sub-resource; the
  // parent distribution is what carries tags).
  RESOURCE_TYPES.CLOUDFRONT_ORIGIN_ACCESS_CONTROL,
  // (f) 2026-04-09 Task 4b: AWS::S3::BucketPolicy — tagging.taggable
  // =false (the policy IS an attribute of the bucket; tags live on
  // the parent AWS::S3::Bucket resource).
  RESOURCE_TYPES.S3_BUCKET_POLICY,
]);

/**
 * Merges mandatory Assignee.ai tags into a desiredState object.
 * Emits Tags in the correct format for the given resource type:
 *   - flat map  { key: value }         for FLAT_MAP_TAG_TYPES (e.g. SSM Parameter)
 *   - array     [{ Key, Value }]        for all other resource types
 * Mandatory tags overwrite any user-supplied tags with the same key.
 *
 * @param desiredState - The resource's desired state object
 * @param runId - Current run UUID (NFR-14 traceability)
 * @param resourceType - CloudFormation resource type (e.g. RESOURCE_TYPES.SSM_PARAMETER)
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
      typeof desiredState[CfnKey.TAGS] === "object" &&
      desiredState[CfnKey.TAGS] !== null &&
      !Array.isArray(desiredState[CfnKey.TAGS])
        ? (desiredState[CfnKey.TAGS] as Record<string, string>)
        : {};
    return {
      ...desiredState,
      [CfnKey.TAGS]: { ...existingTags, ...mandatory },
    };
  }

  // Array format: [{ Key, Value }] — used by S3, IAM, and most others
  const mandatoryCfn: CfnTag[] = Object.entries(mandatory).map(
    ([Key, Value]) => ({ Key, Value }),
  );

  // Resource types with a non-standard tag property name (EFS →
  // FileSystemTags) write to that key and strip any stray "Tags" key
  // the wizard or a pattern may have injected. See ALTERNATE_TAG_KEY_TYPES.
  const alternateTagKey =
    resourceType && ALTERNATE_TAG_KEY_TYPES.get(resourceType);
  const tagPropertyKey = alternateTagKey ?? CfnKey.TAGS;

  // Merge existing tags from BOTH the standard "Tags" key and the
  // alternate key (in case the plugin's field-level toCfn already
  // started populating it). Alternate-key resources end up with a
  // single merged array at the correct property and no stray "Tags".
  const existingFromStandard = Array.isArray(desiredState[CfnKey.TAGS])
    ? (desiredState[CfnKey.TAGS] as CfnTag[])
    : [];
  const existingFromAlternate =
    alternateTagKey && Array.isArray(desiredState[alternateTagKey])
      ? (desiredState[alternateTagKey] as CfnTag[])
      : [];
  const existingTags = [...existingFromStandard, ...existingFromAlternate];

  // Map keyed by tag Key — mandatory tags OVERWRITE duplicates.
  const tagMap = new Map<string, string>();
  for (const tag of existingTags) tagMap.set(tag.Key, tag.Value);
  for (const tag of mandatoryCfn) tagMap.set(tag.Key, tag.Value);

  const mergedTags: CfnTag[] = Array.from(tagMap.entries()).map(
    ([Key, Value]) => ({ Key, Value }),
  );

  const output: Record<string, unknown> = {
    ...desiredState,
    [tagPropertyKey]: mergedTags,
  };
  // When using an alternate key, ensure no stray "Tags" property remains —
  // EFS rejects `extraneous key [Tags] is not permitted` even when
  // FileSystemTags is also present. Guard against a future ALTERNATE_TAG
  // entry accidentally mapping a resource BACK to `Tags` (which would
  // cause this delete to discard the merge we just wrote).
  if (alternateTagKey && alternateTagKey !== CfnKey.TAGS) {
    delete output[CfnKey.TAGS];
  }
  return output;
}
