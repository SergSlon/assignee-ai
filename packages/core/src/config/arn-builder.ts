/**
 * ARN builder — constructs a full AWS ARN from a CloudControl resource
 * type + primary identifier + account/region context.
 *
 * CloudControl's `GetResourceRequestStatus.ProgressEvent.Identifier`
 * returns the resource's PRIMARY identifier, which for most types is
 * the bare name (BucketName, RoleName, FunctionName, TableName, etc.)
 * — NOT the ARN. `assignee apply`'s success output previously displayed
 * this bare identifier in the `ARN:` field, which is misleading for
 * scripting (users can't pipe it back to `assignee destroy <arn>`).
 *
 * This helper centralizes the per-type ARN synthesis so every display
 * path produces consistent, copy-pasteable ARNs. It does NOT do network
 * I/O — callers are responsible for supplying accountId and region.
 *
 * @see Phase 2 smoke test BUG-5
 */

import { ARN_PATTERN, getPartitionFromRegion } from "./aws-partition.js";
import { arnTemplateRegistry } from "./arn-templates.js";

/**
 * AWS partition detected from the region. Thin re-export of
 * `getPartitionFromRegion` kept for backward compatibility with code
 * that imports from `arn-builder.js`. Both return the same value
 * (`aws`, `aws-us-gov`, `aws-cn`, `aws-iso`, `aws-iso-b`).
 *
 * Previously this helper inlined a 3-branch partition check that
 * defaulted ISO regions to `aws` — silently producing wrong-partition
 * ARNs. Wave 4 F1 consolidates both into the single source of truth.
 */
export function partitionForRegion(region: string): string {
  return getPartitionFromRegion(region);
}

/**
 * Args for buildResourceArn. All fields are required except partition
 * (defaulted from region). identifier must be the CloudControl primary
 * identifier as returned by GetResourceRequestStatus — NOT the ARN.
 */
export interface BuildResourceArnArgs {
  resourceType: string;
  identifier: string;
  region: string;
  accountId: string;
  partition?: string;
}

/**
 * Returns true if the given string already looks like a full AWS ARN.
 * Used as a short-circuit in display paths: if CloudControl happened
 * to return an ARN (some types do — ELBv2 LoadBalancer, ECS Cluster),
 * we don't re-synthesize.
 */
export function isArn(value: string): boolean {
  return ARN_PATTERN.test(value);
}

/**
 * Builds the canonical ARN for a supported CloudFormation resource
 * type, given its primary identifier. Returns the input identifier
 * unchanged when:
 *   - it already looks like an ARN (isArn check)
 *   - the resource type is unknown or has no stable ARN format
 *
 * The per-type branches mirror AWS's own ARN formats documented in
 * the IAM policy reference. When adding support for a new resource
 * type, add both the RESOURCE_TYPES constant AND the ARN format here.
 *
 * Tests in arn-builder.test.ts cover every type in RESOURCE_TYPES.
 */
export function buildResourceArn(args: BuildResourceArnArgs): string {
  const { resourceType, identifier, region, accountId } = args;
  const partition = args.partition ?? partitionForRegion(region);

  // Already an ARN — preserve it verbatim. CloudControl returns full
  // ARNs for a few types (ELBv2 LoadBalancer, ECS Cluster, SNS Topic).
  if (isArn(identifier)) return identifier;

  // Story 49.4: table-driven synthesis. Per-type templates live in
  // arn-templates.ts; adding a new resource type is a single entry
  // there. Unknown types fall through to the identifier below.
  const template = arnTemplateRegistry[resourceType];
  if (template) {
    return template({ partition, region, accountId, identifier });
  }
  return identifier;
}
