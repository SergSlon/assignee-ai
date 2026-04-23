/**
 * Apply-envelope ARN/primaryIdentifier projection.
 *
 * Closes Epic 97 A-01 + B-01 (HIGH × 2): the apply JSON envelope's `arn`
 * field returned a bare CCAPI identifier for Lambda compound and for
 * non-taggable CFN constructs (Route / SubnetRouteTableAssociation /
 * VPCGatewayAttachment), while S3 / DDB / SNS / SQS / VPC / Subnet / SG
 * returned a full ARN. Scripts that piped `jq .arn` into follow-up
 * `destroy <arn>` broke on the bare-identifier types.
 *
 * Projection rules:
 *
 *   1. Non-taggable CFN construct (no standalone ARN in AWS):
 *        arn: null
 *        primaryIdentifier: "<bare id>"
 *      Consumers parse `primaryIdentifier` — W1.B1 made the destroy path
 *      dual-index the provision log on this value, so
 *      `destroy <primaryIdentifier>` resolves.
 *
 *   2. ARN-addressable type (everything else):
 *        arn: "arn:<partition>:<service>:<region>:<account>:..."
 *        primaryIdentifier: null
 *      Full ARN synthesised via `resolveResourceArn` (STS-backed account
 *      lookup + `buildResourceArn`). If STS is unavailable (missing creds,
 *      timeout, AccessDenied), the projection falls back to the bare
 *      identifier in `arn` so the envelope is never empty — same tradeoff
 *      as `resolveDisplayArn` in `arn-display.ts`.
 */

import { isNonTaggableConstruct } from "@/managed-resources/index.js";
import { resolveResourceArn } from "@/utils/resolve-arn.js";

export interface ApplyEnvelopeArn {
  /**
   * Full AWS ARN (`arn:<partition>:...`). `null` iff the resource type is
   * non-taggable and has no standalone AWS ARN. Never `undefined`.
   */
  arn: string | null;
  /**
   * Bare CCAPI primary identifier for non-taggable constructs
   * (`rtb-XXX|<cidr>`, `rtbassoc-XXX`, `igw-XXX|vpc-YYY`). `null` when the
   * resource type IS ARN-addressable and `arn` carries the canonical form.
   */
  primaryIdentifier: string | null;
}

/**
 * Project `(resourceType, identifier)` → `{arn, primaryIdentifier}` for
 * the apply JSON envelope.
 *
 * Returns `{arn: null, primaryIdentifier: null}` when `identifier` is
 * empty — caller is responsible for omitting both fields in that case
 * (the two `null`s are a contract marker, not a valid envelope value).
 */
export async function buildApplyEnvelopeArn(
  resourceType: string | undefined,
  identifier: string | undefined,
): Promise<ApplyEnvelopeArn> {
  if (!identifier || !resourceType) {
    return { arn: null, primaryIdentifier: null };
  }

  if (isNonTaggableConstruct(resourceType)) {
    return { arn: null, primaryIdentifier: identifier };
  }

  const resolved = await resolveResourceArn({ resourceType, identifier });
  return {
    arn: resolved ?? identifier,
    primaryIdentifier: null,
  };
}
