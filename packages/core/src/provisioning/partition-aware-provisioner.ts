/**
 * Partition-aware provisioning router (W5-04, P055 → L5-S08).
 *
 * Checks whether CloudControl API (CCAPI) is available for a given resource
 * type in the operator's partition. If CCAPI is not supported AND an SDK-direct
 * fallback exists, routes to the SDK-direct adapter. Otherwise emits an
 * actionable "not supported in <partition>" error.
 *
 * Integration point: the `resourceProvisionerNode` in
 * `packages/core/src/graph/nodes/resource-provisioner.ts` calls
 * `routeProvisioningByPartition()` before the CCAPI create path.
 *
 * Commercial partition (`aws`) is a no-op passthrough — zero behaviour change.
 *
 * Pragmatic deferral (Epic 102+):
 *   Full SDK-direct coverage for all 38+ types. This module wires the routing
 *   logic for 3 types (S3/IAM/VPC). All others in non-commercial partitions
 *   produce an actionable error message.
 */

import { getPartitionFromRegion } from "../config/aws-partition.js";
import { AWS_REGION } from "../config/constants/aws.js";
import {
  isCcapiSupported,
  hasSdkDirectFallback,
  assertCcapiSupportedOrActionableError,
} from "./ccapi-partition-support.js";
import { createS3BucketSdkDirect } from "./sdk-direct-fallback/s3-bucket.js";
import { createIamRoleSdkDirect } from "./sdk-direct-fallback/iam-role.js";
import { createEc2VpcSdkDirect } from "./sdk-direct-fallback/ec2-vpc.js";

export interface PartitionRouteResult {
  /** When true, the SDK-direct path handled the provision. Skip CCAPI. */
  handled: boolean;
  /** Primary identifier returned by the SDK (only set when handled: true). */
  identifier?: string;
}

/**
 * Checks the partition × resource-type support matrix and either:
 *   1. Returns `{ handled: false }` — CCAPI is supported; caller proceeds normally.
 *   2. Returns `{ handled: true, requestToken, identifier }` — SDK-direct adapter ran.
 *   3. Throws an actionable error — not supported and no fallback available.
 *
 * @param resourceType    - CloudFormation type, e.g. "AWS::S3::Bucket"
 * @param desiredStateJson - JSON desired-state properties for the resource
 * @param region          - AWS region (defaults to AWS_REGION env var)
 */
export async function routeProvisioningByPartition(
  resourceType: string,
  desiredStateJson: string,
  region: string = AWS_REGION,
): Promise<PartitionRouteResult> {
  const partition = getPartitionFromRegion(region);

  // Commercial partition — CCAPI supports everything; no routing needed.
  if (partition === "aws") {
    return { handled: false };
  }

  // Non-commercial: check if CCAPI supports this type.
  if (isCcapiSupported(partition, resourceType)) {
    return { handled: false };
  }

  // CCAPI not supported. Check for SDK-direct fallback.
  if (hasSdkDirectFallback(resourceType)) {
    const result = await dispatchSdkDirect(
      resourceType,
      desiredStateJson,
      region,
    );
    return {
      handled: true,
      identifier: result.identifier,
    };
  }

  // No fallback — throw actionable error (no silent failure).
  assertCcapiSupportedOrActionableError(partition, resourceType);

  // TypeScript: unreachable but satisfies return type.
  return { handled: false };
}

/**
 * Dispatches to the correct SDK-direct adapter for the given resource type.
 * Only called when `hasSdkDirectFallback(resourceType)` is true.
 */
async function dispatchSdkDirect(
  resourceType: string,
  desiredStateJson: string,
  region: string,
): Promise<{ requestToken: string; identifier: string }> {
  switch (resourceType) {
    case "AWS::S3::Bucket": {
      const r = await createS3BucketSdkDirect(desiredStateJson, region);
      return { requestToken: r.requestToken, identifier: r.identifier };
    }
    case "AWS::IAM::Role": {
      const r = await createIamRoleSdkDirect(desiredStateJson, region);
      return { requestToken: r.requestToken, identifier: r.identifier };
    }
    case "AWS::EC2::VPC": {
      const r = await createEc2VpcSdkDirect(desiredStateJson, region);
      return { requestToken: r.requestToken, identifier: r.identifier };
    }
    default:
      throw new Error(
        `dispatchSdkDirect: no adapter registered for "${resourceType}". ` +
          `This is a bug — hasSdkDirectFallback() should have returned false.`,
      );
  }
}
