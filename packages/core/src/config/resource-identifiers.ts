/**
 * Maps each POC resource type to its CloudFormation primary identifier key.
 * Used by resource_provisioner State Guard (FR-15 Read-Before-Write) to extract
 * the identifier from desiredState before calling GetResource.
 *
 * @see implementation-artifacts/2-2-implement-resource-provisioner-node-with-state-guard.md
 */

import { RESOURCE_TYPES, type ResourceType } from './resource-types.js'

export const RESOURCE_IDENTIFIER_KEYS: Record<ResourceType, string> = {
  [RESOURCE_TYPES.S3_BUCKET]: 'BucketName',
  [RESOURCE_TYPES.SSM_PARAMETER]: 'Name',
  [RESOURCE_TYPES.IAM_ROLE]: 'RoleName',
} as const

/**
 * Returns the primary identifier value extracted from a desiredState object
 * for the given resource type. Returns `undefined` if type has no known mapping.
 */
export function getPrimaryIdentifier(
  resourceType: ResourceType,
  desiredState: Record<string, unknown>,
): string | undefined {
  const key = RESOURCE_IDENTIFIER_KEYS[resourceType]
  if (!key) return undefined
  const val = desiredState[key]
  return typeof val === 'string' ? val : undefined
}
