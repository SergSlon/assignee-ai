/**
 * BulkDestroyService — lists, classifies, and orders managed resources
 * for bulk destruction.
 *
 * Queries the Resource Groups Tagging API for resources tagged with
 * `managed-by=assignee-ai`, classifies each by CloudFormation type,
 * assigns a dependency tier, and returns a destruction plan ordered
 * so dependents are removed before their foundations.
 *
 * @see Story 36.2
 */

import {
  RESOURCE_TYPES,
  LIST_RESOURCE_TYPES,
  COMPANION_RESOURCE_TYPES,
} from "@assignee/core";
import { fetchManagedResources } from "./list-resources.js";

/** A managed resource enriched with destruction-ordering metadata. */
export interface ManagedResource {
  arn: string;
  resourceType: string;
  identifier: string;
  region: string;
  tier: number; // destruction order tier (1=first, 6=last)
}

/** The result of planning a bulk destroy operation. */
export interface BulkDestroyPlan {
  resources: ManagedResource[]; // ordered by tier ascending (destroy order)
  totalCount: number;
  iamCount: number; // how many are IAM (excluded by default)
  excludedCount: number; // how many filtered out
}

/** Options for filtering and controlling the bulk destroy plan. */
export interface BulkDestroyOptions {
  includeIam?: boolean; // include IAM policies/roles (default: false)
  pattern?: RegExp; // filter by identifier pattern (for clean --resources)
  region?: string; // filter by region
}

/**
 * Dependency tier mapping for destruction order.
 * Lower tier = destroyed first (dependents before foundations).
 */
export const DESTROY_TIER: Record<string, number> = {
  // Tier 1: Leaf resources and CDN (no dependents, or must be removed before origin)
  [RESOURCE_TYPES.EC2_ROUTE]: 1,
  [RESOURCE_TYPES.CLOUDWATCH_ALARM]: 1,
  [RESOURCE_TYPES.SECRETSMANAGER_SECRET]: 1,
  [RESOURCE_TYPES.LOGS_LOG_GROUP]: 1,
  [RESOURCE_TYPES.SSM_PARAMETER]: 1,
  // (f) 2026-04-09 Task 4b: static-website compound destroy order.
  // The BucketPolicy holds an aws:SourceArn reference to the
  // distribution — the policy must be deleted BEFORE both the
  // bucket (S3 ordering) and the distribution (clean reference
  // semantics). Tier 0 goes first, then the distribution at tier 1
  // (disabled + deleted), then the OAC at tier 2 (CloudFront
  // rejects OAC deletion while an attached distribution is still
  // active), then the bucket at tier 5.
  [RESOURCE_TYPES.S3_BUCKET_POLICY]: 0,
  [RESOURCE_TYPES.CLOUDFRONT_DISTRIBUTION]: 1, // Must be disabled/deleted before S3 bucket
  [RESOURCE_TYPES.CLOUDFRONT_ORIGIN_ACCESS_CONTROL]: 2,
  // Tier 2: Service resources
  [RESOURCE_TYPES.LAMBDA_FUNCTION]: 2,
  [RESOURCE_TYPES.SQS_QUEUE]: 2,
  [RESOURCE_TYPES.SNS_TOPIC]: 2,
  [RESOURCE_TYPES.DYNAMODB_TABLE]: 2,
  [RESOURCE_TYPES.APIGATEWAYV2_API]: 2,
  // Tier 3: Compute/DB/Network services
  [RESOURCE_TYPES.EC2_INSTANCE]: 3,
  [RESOURCE_TYPES.RDS_DB_INSTANCE]: 3,
  [RESOURCE_TYPES.ELBV2_LOAD_BALANCER]: 3,
  [RESOURCE_TYPES.EC2_NAT_GATEWAY]: 3,
  [RESOURCE_TYPES.ECR_REPOSITORY]: 3,
  [RESOURCE_TYPES.ECS_CLUSTER]: 3,
  // Tier 4: Network infrastructure
  [RESOURCE_TYPES.EC2_SECURITY_GROUP]: 4,
  [RESOURCE_TYPES.EC2_SUBNET]: 4,
  [RESOURCE_TYPES.EC2_INTERNET_GATEWAY]: 4,
  [RESOURCE_TYPES.EC2_ROUTE_TABLE]: 4,
  // Wave 19 Bug #6: EIP must be released AFTER NAT Gateway (tier 3) but
  // before VPC (tier 5). EIP is technically a companion resource type,
  // but it's the only one in COMPANION_RESOURCE_TYPES that ends up
  // standalone-tagged in AWS — every NAT Gateway compound run leaves an
  // EIP behind that needs explicit cleanup. Tier 4 puts it alongside the
  // network infrastructure that holds it, after the NAT Gateway that
  // references it. CCAPI supports `AWS::EC2::EIP` deletion via the
  // standard destroy path. Combined with the managed-by=assignee-ai tag
  // added in resource-provisioner.ts (also Wave 19 Bug #6), this finally
  // closes the EIP leak loop observed during the 2026-04-08 live smoke.
  [COMPANION_RESOURCE_TYPES.EC2_EIP]: 4,
  // Tier 5: Foundations
  [RESOURCE_TYPES.S3_BUCKET]: 5,
  [RESOURCE_TYPES.EC2_VPC]: 5,
  // Tier 6: Identity (opt-in only)
  [RESOURCE_TYPES.IAM_ROLE]: 6,
  [LIST_RESOURCE_TYPES.IAM_MANAGED_POLICY]: 6,
};

/** Default tier for resource types not in the DESTROY_TIER map. */
const DEFAULT_TIER = 3;

/** IAM resource type prefixes — used to identify IAM resources for opt-in filtering. */
const IAM_TYPE_PREFIX = "AWS::IAM::";

/**
 * IAM resources that belong to assignee.ai's own operator infrastructure
 * and must NEVER be destroyed by `destroy --all --include-iam`. These are
 * created by `assignee setup` and removing them locks the user out of
 * their own AWS account / breaks every subsequent assignee command.
 *
 * Anchored regex on the ARN's resource name (the segment after the last
 * `/`). The leading `^` and trailing `$` are mandatory — a substring
 * match would over-protect roles like `MyAssigneeOperatorPolicyClone`.
 */
// A8 follow-up: added optional `Services` segment so the
// AssigneeOperatorServicesPolicy (the second half of the operator
// policy split) is also covered by the safety allowlist. Without
// this, `assignee destroy --all --include-iam` would destroy the
// services policy and lock the operator user out of every
// service-specific permission. The leading `^` and trailing `$`
// stay mandatory so substring matches like
// `MyAssigneeOperatorServicesPolicyClone` are NOT protected.
//
// (f) 2026-04-09 A/B split: the services half was split once more
// into Services-A + Services-B to fit inside the 6144-byte managed
// policy limit. The optional `[AB]?` segment matches the new names
// (AssigneeOperatorServicesAPolicy, AssigneeOperatorServicesBPolicy)
// AND keeps matching the legacy AssigneeOperatorServicesPolicy name
// so existing installations are still protected during the upgrade
// window. The trailing `$` anchor means Clone/Backup suffixes are
// still NOT protected — substring spoofing requires an exact match.
const ASSIGNEE_INFRA_NAME_PATTERN =
  /^Assignee(Ai)?(Operator|Reader|Auditor|Bedrock\w*)?(Services[AB]?)?(Policy|Role|User|Group)?$/;

/**
 * Returns true when the given ARN points at one of assignee.ai's own
 * setup-created IAM resources. Used as a safety filter in
 * planBulkDestroy so an `--include-iam` sweep cannot self-destruct
 * the operator/reader/auditor policies the CLI itself depends on.
 */
export function isAssigneeInfraResource(arn: string): boolean {
  // ARN format examples (partition-aware to cover GovCloud + China):
  //   arn:aws:iam::123:policy/AssigneeOperatorPolicy
  //   arn:aws-us-gov:iam::123:role/AssigneeAiBedrockLoggingRole
  //   arn:aws-cn:iam::123:role/AssigneeReaderPolicy
  // The literal commercial-only check that lived here through Wave 9 let
  // GovCloud / China users self-lockout via `--include-iam` because the
  // safety allowlist silently dropped through. The `[\w-]*` partition
  // segment matches `aws`, `aws-us-gov`, `aws-cn`, and any future
  // partitions AWS introduces — same convention as `isArn()` in
  // packages/core/src/config/arn-builder.ts.
  if (!/^arn:aws[\w-]*:iam::/.test(arn)) return false;
  const lastSegment = arn.split("/").pop() ?? "";
  return ASSIGNEE_INFRA_NAME_PATTERN.test(lastSegment);
}

/**
 * Extracts a human-readable identifier from an ARN.
 *
 * Examples:
 *   "arn:aws:s3:::my-bucket"                          -> "my-bucket"
 *   "arn:aws:lambda:us-east-1:123:function:my-func"   -> "my-func"
 *   "arn:aws:ec2:us-east-1:123:instance/i-abc123"     -> "i-abc123"
 */
function extractIdentifier(arn: string): string {
  const parts = arn.split(":");
  if (parts.length < 6) return arn;

  const resourceSection = parts.slice(5).join(":");

  // Colon-separated: "type:identifier"
  const colonParts = resourceSection.split(":");
  if (colonParts.length >= 2) {
    const resourceType = colonParts[0]!;
    const afterType = colonParts.slice(1).join(":");
    if (afterType && !resourceType.includes("/")) {
      return afterType;
    }
  }

  // SSM parameter: "parameter/<name>" — preserve canonical leading slash
  // since SSM parameter names (and the CloudControl identifier) always begin
  // with "/". e.g. "parameter/e2e-test/param1" -> "/e2e-test/param1"
  if (resourceSection.startsWith("parameter/")) {
    return "/" + resourceSection.slice("parameter/".length);
  }

  // Slash-separated: "type/identifier"
  const slashIdx = resourceSection.indexOf("/");
  if (slashIdx !== -1) {
    if (resourceSection.startsWith("/")) {
      const segments = resourceSection.split("/").filter(Boolean);
      return segments[segments.length - 1] ?? arn;
    }
    return resourceSection.slice(slashIdx + 1) || arn;
  }

  return resourceSection || arn;
}

/**
 * Determines whether a resource type is an IAM type.
 */
function isIamType(resourceType: string): boolean {
  return resourceType.startsWith(IAM_TYPE_PREFIX);
}

/**
 * Builds a bulk destruction plan by listing all managed resources,
 * classifying them by type and dependency tier, and ordering them
 * for safe destruction (dependents before foundations).
 *
 * @param options - Filtering and control options
 * @returns A BulkDestroyPlan with ordered resources and summary counts
 */
export async function planBulkDestroy(
  options?: BulkDestroyOptions,
): Promise<BulkDestroyPlan> {
  let fetchedResources;
  try {
    fetchedResources = await fetchManagedResources(options?.region);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Failed to list managed resources. Check your AWS credentials and network connection. Details: ${message}`,
    );
  }

  return buildPlanFromResources(fetchedResources, options);
}

/**
 * Pure plan builder — takes already-fetched resources and produces a
 * BulkDestroyPlan. Exported for unit testing without AWS calls.
 */
export function buildPlanFromResources(
  fetchedResources: Array<{
    arn: string;
    resourceType: string;
    region: string;
  }>,
  options?: BulkDestroyOptions,
): BulkDestroyPlan {
  const includeIam = options?.includeIam ?? false;
  const pattern = options?.pattern;
  const regionFilter = options?.region;

  let iamCount = 0;
  let excludedCount = 0;
  const resources: ManagedResource[] = [];

  for (const fetched of fetchedResources) {
    const { arn, resourceType, region } = fetched;
    const identifier = extractIdentifier(arn);
    const tier = DESTROY_TIER[resourceType] ?? DEFAULT_TIER;
    const iam = isIamType(resourceType);

    if (iam) {
      iamCount++;
    }

    // Safety allowlist: never destroy assignee.ai's own setup-created
    // operator infrastructure, even when --include-iam is set. These
    // resources (AssigneeOperatorPolicy, AssigneeReaderPolicy, etc.)
    // are created by `assignee setup` and removing them locks the
    // user out of their own AWS account.
    if (isAssigneeInfraResource(arn)) {
      excludedCount++;
      continue;
    }

    // Filter: IAM exclusion (unless opted-in)
    if (iam && !includeIam) {
      excludedCount++;
      continue;
    }

    // Filter: region. IAM is a global service — its resources carry
    // region="global" in the inventory, which would otherwise be
    // filtered out by any region scope. Skip the region check for
    // global resources so `destroy --all --include-iam` actually
    // includes user IAM roles regardless of operator region.
    const isGlobalService = region === "global";
    if (regionFilter && !isGlobalService && region !== regionFilter) {
      excludedCount++;
      continue;
    }

    // Filter: pattern (match against ARN or identifier)
    if (pattern && !pattern.test(arn) && !pattern.test(identifier)) {
      excludedCount++;
      continue;
    }

    resources.push({ arn, resourceType, identifier, region, tier });
  }

  // Sort by tier ascending — tier 1 destroyed first, tier 6 last
  resources.sort((a, b) => a.tier - b.tier);

  return {
    resources,
    totalCount: fetchedResources.length,
    iamCount,
    excludedCount,
  };
}
