/**
 * Non-taggable construct classifier + primaryIdentifier helpers.
 *
 * Context (Epic 98 e98.W1.B1, Epic 97 B-02 BLOCKER):
 *
 *   A handful of CloudFormation resource types are "non-taggable"
 *   constructs — they exist in CFN but AWS does not support tagging
 *   them (they're really sub-resources of taggable parents). Concretely:
 *
 *     - AWS::EC2::Route                   (child of RouteTable; PK: `rtb-XXX|<destCidr>`)
 *     - AWS::EC2::SubnetRouteTableAssociation  (child of Subnet; PK: `rtbassoc-XXX`)
 *     - AWS::EC2::VPCGatewayAttachment    (child of IGW; PK: `igw-XXX|vpc-YYY`)
 *     - AWS::S3::BucketPolicy             (attribute of a bucket; PK: bucket name)
 *     - AWS::CloudFront::OriginAccessControl (PK: `E...` id; has ARN but
 *       CCAPI returns bare id; consumers reference by id only)
 *
 *   Because RGTA only returns taggable resources, an apply of any of
 *   these types leaves NO trail that `assignee admin list` can surface via
 *   the tagging API, and `destroy <primaryIdentifier>` can't resolve
 *   them either — user-facing orphan state. This module is the
 *   classifier + lookup plumbing the list + destroy paths use to close
 *   the B-02 gap via the provision log.
 *
 * SRP: one reason to change — when AWS adds/removes tag support on a
 * CFN type, the `NON_TAGGABLE_RESOURCE_TYPES` set is the single edit site.
 */

import { RESOURCE_TYPES } from "@/config/resource-types.js";

/**
 * Closed set of CFN resource types that AWS does NOT support tagging
 * on (via CCAPI or otherwise). Every entry here must ALSO be listed in
 * `arn-templates.ts` as "Route & cross-reference types without standalone
 * ARNs" — the two facts are the same statement from two angles.
 *
 * Adding a new non-taggable type requires:
 *   1. Add the CFN type string here.
 *   2. Add the matching `arn-templates.ts` entry (identifier-passthrough).
 *   3. Extend `packages/core/src/graph/nodes/__tests__/
 *      non-taggable-resource-registration.test.ts` to cover the new type.
 *
 * DC-1 (DF-OAC-LIST-DESTROY-MISMATCH): CLOUDFRONT_ORIGIN_ACCESS_CONTROL and
 * S3_BUCKET_POLICY added here. Both types have ARN formats on paper, but
 * CCAPI returns their bare primaryIdentifier (OAC Id / bucket name) rather
 * than a full ARN. RGTA does not enumerate either type, so `assignee admin list`
 * surfaces them via the provision log (keyKind: "primaryIdentifier") and
 * `assignee infra destroy <bare-id>` must resolve them the same way.
 */
export const NON_TAGGABLE_RESOURCE_TYPES: ReadonlySet<string> = new Set<string>(
  [
    RESOURCE_TYPES.EC2_ROUTE,
    RESOURCE_TYPES.EC2_SUBNET_ROUTE_TABLE_ASSOCIATION,
    RESOURCE_TYPES.EC2_VPC_GATEWAY_ATTACHMENT,
    // DC-1: CCAPI returns bare OAC Id (E3EYXPSYURQIM9), not a full ARN.
    // RGTA does not index OAC resources — provision log is the only trail.
    RESOURCE_TYPES.CLOUDFRONT_ORIGIN_ACCESS_CONTROL,
    // DC-1: CCAPI primary identifier for BucketPolicy is the bucket name.
    // Same RGTA gap — provision log is the only trail.
    RESOURCE_TYPES.S3_BUCKET_POLICY,
  ],
);

/**
 * `true` if CCAPI's primaryIdentifier for this type is NOT an ARN-
 * addressable resource tag-visible via RGTA. Callers use this to branch
 * into the provision-log-only lookup paths (list, destroy, resolver).
 *
 * Order of checks matters: the classifier is a pure data lookup, so use
 * it as the outermost gate before doing any RGTA work for a given type.
 */
export function isNonTaggableConstruct(resourceType: string): boolean {
  return NON_TAGGABLE_RESOURCE_TYPES.has(resourceType);
}
