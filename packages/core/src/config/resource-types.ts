/**
 * AWS CloudFormation resource type constants for the POC phase.
 * Single source of truth — used by intent_parser, schema_fetcher, resource_provisioner,
 * preflight_guard, and (in MVP) the policy validation engine.
 *
 * @see project-context.md — No Magic Strings section
 */

export const RESOURCE_TYPES = {
  S3_BUCKET: 'AWS::S3::Bucket',
  SSM_PARAMETER: 'AWS::SSM::Parameter',
  IAM_ROLE: 'AWS::IAM::Role',
} as const

export type ResourceType = typeof RESOURCE_TYPES[keyof typeof RESOURCE_TYPES]

/** Ordered tuple of all resource types supported in the POC phase. */
export const SUPPORTED_POC_TYPES = Object.values(RESOURCE_TYPES) as ResourceType[]
