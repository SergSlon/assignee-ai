/**
 * Shared ARN parser used by both apps/cli and apps/mcp-server when
 * converting RGTA `ResourceARN` strings back into display/filter
 * shape.
 *
 * ARN format: `arn:partition:service:region:account-id:resource-type/resource-id`
 *
 * Handles the standard aws/aws-cn/aws-us-gov partitions — each ARN is
 * parsed by colon-splitting so the partition-specific prefix is
 * transparent. The service and region fields are returned as-is; the
 * resource-type is normalized to the CloudFormation `AWS::*::*` form
 * via `arnToCloudFormationType`.
 *
 * @see Story 49.2 — extraction from the duplicated per-app copies.
 * @see feedback_partition_aware_arn_matching.md
 */

import { arnToCloudFormationType } from "../config/arn-type-map.js";
import { UNKNOWN_FALLBACK } from "../config/cfn-keys/defaults.js";

export function parseArn(arn: string): {
  service: string;
  region: string;
  resourceType: string;
} {
  const parts = arn.split(":");
  return {
    service: parts[2] ?? UNKNOWN_FALLBACK,
    region: parts[3] ?? UNKNOWN_FALLBACK,
    resourceType: arnToCloudFormationType(parts[2] ?? "", parts[5] ?? ""),
  };
}
