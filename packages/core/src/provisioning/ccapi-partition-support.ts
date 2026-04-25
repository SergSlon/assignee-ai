/**
 * CloudControl API (CCAPI) partition × resource-type support matrix.
 *
 * W5-04 (P055 → L5-S08): CCAPI does not support all resource types in
 * all partitions. Today a missing type silently fails at provision-time.
 * This module provides:
 *   1. A machine-readable support matrix (partition × resource-type).
 *   2. `isCcapiSupported(partition, resourceType)` — predicate for routing.
 *   3. `assertCcapiSupportedOrActionableError(...)` — throws with an
 *      actionable message for unsupported partition/type combos.
 *
 * Sources:
 * @see https://docs.aws.amazon.com/cloudcontrolapi/latest/userguide/supported-resources.html
 *   — CCAPI public documentation. Verified 2026-04-25 by coordinator.
 *   GovCloud / ISO support is a subset; China is mostly unsupported.
 *   The matrix below is conservative: only types verified as SUPPORTED
 *   in non-commercial partitions are listed in the opt-in sets. Everything
 *   else defaults to CCAPI-only in commercial (`aws`) partition.
 *
 * Maintenance:
 *   When AWS extends CCAPI support to new types in non-commercial partitions,
 *   add the `resourceType` to the relevant partition set below and update
 *   the sourcing-date comment. Do NOT speculatively add types — false
 *   positives cause silent failures.
 *
 * Pragmatic deferral (Epic 102+):
 *   Full SDK-direct fallback for all 38+ resource types is Epic 102+ scope.
 *   This story wires the matrix + 3 SDK-direct adapters (S3 bucket, IAM
 *   role, EC2 VPC). All other types in non-commercial partitions receive an
 *   actionable "not supported in <partition>" error message.
 */

import type { AwsPartition } from "../config/aws-partition.js";

/**
 * The commercial (`aws`) partition supports CCAPI for all registered types
 * by assumption. The opt-in sets below list types that ALSO work in
 * non-commercial partitions. Every other type in non-commercial partitions
 * routes to `SdkDirectFallback` (if implemented) or an actionable error.
 */

/**
 * Resource types confirmed CCAPI-supported in GovCloud (`aws-us-gov`).
 *
 * Conservative posture: the three types with W5-04 SDK-direct fallback adapters
 * (S3 Bucket, IAM Role, EC2 VPC) are EXCLUDED from this set so the router
 * prefers the verified SDK-direct path over a partial CCAPI surface where
 * specific create-property combinations may silently 4xx. CCAPI coverage in
 * GovCloud is uneven across resource property shapes; the SDK-direct adapters
 * cover the create-time operations Assignee actually needs.
 *
 * Other types listed here are CCAPI-only in this partition until SDK-direct
 * adapters land in Epic 102+; they have no fallback so failure produces an
 * actionable error.
 *
 * Source: AWS CCAPI supported-resources page, filtered for us-gov-east-1
 * and us-gov-west-1. Verified 2026-04-25.
 */
const GOVCLOUD_CCAPI_SUPPORTED = new Set<string>([
  "AWS::EC2::Subnet",
  "AWS::EC2::SecurityGroup",
  "AWS::CloudWatch::Alarm",
  "AWS::SSM::Parameter",
  "AWS::SecretsManager::Secret",
  "AWS::Lambda::Function",
  "AWS::DynamoDB::Table",
  "AWS::SQS::Queue",
  "AWS::SNS::Topic",
  "AWS::KMS::Key",
  "AWS::Logs::LogGroup",
]);

/**
 * Resource types confirmed CCAPI-supported in China (`aws-cn`).
 *
 * Conservative posture (see GOVCLOUD note): S3/IAM/VPC routed through
 * W5-04 SDK-direct adapters; the rest stay CCAPI-only.
 *
 * China has the most restricted CCAPI support surface overall. Verified 2026-04-25.
 */
const CHINA_CCAPI_SUPPORTED = new Set<string>([
  "AWS::EC2::Subnet",
  "AWS::EC2::SecurityGroup",
  "AWS::DynamoDB::Table",
  "AWS::SQS::Queue",
  "AWS::Logs::LogGroup",
]);

/**
 * Resource types confirmed CCAPI-supported in ISO (`aws-iso`).
 *
 * Conservative posture (see GOVCLOUD note): S3/IAM/VPC routed through
 * W5-04 SDK-direct adapters; the rest stay CCAPI-only.
 *
 * ISO is an air-gapped partition with a reduced service set. Verified 2026-04-25.
 */
const ISO_CCAPI_SUPPORTED = new Set<string>([
  "AWS::EC2::Subnet",
  "AWS::EC2::SecurityGroup",
  "AWS::Logs::LogGroup",
]);

/**
 * Resource types confirmed CCAPI-supported in EU Sovereign Cloud (`aws-iso-e`).
 *
 * Conservative posture (see GOVCLOUD note): S3/IAM/VPC routed through
 * W5-04 SDK-direct adapters; the rest stay CCAPI-only.
 *
 * Extremely limited CCAPI surface — treat same as ISO for now. Verified 2026-04-25.
 */
const ISO_E_CCAPI_SUPPORTED = new Set<string>([
  "AWS::EC2::Subnet",
  "AWS::EC2::SecurityGroup",
]);

/**
 * Lookup table: partition → set of CCAPI-supported resource types.
 * `aws` is not in the table — commercial partition assumed to support all types.
 */
const PARTITION_SUPPORT_MAP: Partial<Record<AwsPartition, Set<string>>> = {
  "aws-us-gov": GOVCLOUD_CCAPI_SUPPORTED,
  "aws-cn": CHINA_CCAPI_SUPPORTED,
  "aws-iso": ISO_CCAPI_SUPPORTED,
  "aws-iso-b": ISO_CCAPI_SUPPORTED, // Same surface as aws-iso
  "aws-iso-e": ISO_E_CCAPI_SUPPORTED,
};

/**
 * Returns true when CloudControl API is known to support `resourceType`
 * in `partition`. Conservative: unknown partitions and unknown types in
 * non-commercial partitions return false.
 *
 * @param partition  - e.g. "aws", "aws-us-gov", "aws-cn", "aws-iso", "aws-iso-e"
 * @param resourceType - CloudFormation resource type, e.g. "AWS::S3::Bucket"
 */
export function isCcapiSupported(
  partition: string,
  resourceType: string,
): boolean {
  // Commercial partition — CCAPI supports all registered types.
  if (partition === "aws") return true;

  const supported = PARTITION_SUPPORT_MAP[partition as AwsPartition];
  if (!supported) {
    // Unknown partition — assume not supported (safe default).
    return false;
  }
  return supported.has(resourceType);
}

/**
 * Throws an actionable error when CCAPI is not supported for the given
 * partition and resource type. No-op when supported.
 *
 * Error message format: actionable, naming partition + type + fallback status.
 */
export function assertCcapiSupportedOrActionableError(
  partition: string,
  resourceType: string,
): void {
  if (isCcapiSupported(partition, resourceType)) return;

  throw new Error(
    `CloudControl API does not support "${resourceType}" in the "${partition}" partition. ` +
      `This resource type is not available via CCAPI in this partition. ` +
      `For S3 buckets, IAM roles, and EC2 VPCs, Assignee falls back to SDK-direct provisioning. ` +
      `For other types in non-commercial partitions, manual provisioning via the AWS Console or CDK is required. ` +
      `See https://docs.aws.amazon.com/cloudcontrolapi/latest/userguide/supported-resources.html for the current support matrix.`,
  );
}

/**
 * Resource types that have an SDK-direct fallback implementation.
 * W5-04: first 3 highest-value types. Extended in Epic 102+.
 */
export const SDK_DIRECT_FALLBACK_TYPES = new Set<string>([
  "AWS::S3::Bucket",
  "AWS::IAM::Role",
  "AWS::EC2::VPC",
]);

/**
 * Returns true when an SDK-direct fallback adapter exists for this
 * resource type. Used by the provisioner to route non-CCAPI paths.
 */
export function hasSdkDirectFallback(resourceType: string): boolean {
  return SDK_DIRECT_FALLBACK_TYPES.has(resourceType);
}
