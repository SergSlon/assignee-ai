/**
 * Shared helper for the CLI `list` / `status` `--resource-type <type>`
 * filter. Centralises:
 *
 *   1. **SSO validation** — checks the user-supplied type against
 *      `SUPPORTED_TYPES_ARRAY` from `@assignee/core`. No hardcoded
 *      resource-type list lives here or in the command files (see
 *      invariant in `docs/explanation/invariants.md` + memory
 *      `feedback_help_hints_sso`).
 *   2. **Shorthand normalisation** — users can type either the full
 *      CFN type (`AWS::S3::Bucket`) or a friendly shorthand (`S3`,
 *      `Lambda`, `DynamoDB`, `RDS`, …). The shorthand matches
 *      case-insensitively against the final CFN segment (e.g.
 *      `Bucket`), or against the `<Service>::<Type>` tail
 *      (`S3::Bucket`), or against the service name when a single
 *      supported type exists for that service (`S3` → `AWS::S3::Bucket`,
 *      `Lambda` → `AWS::Lambda::Function`).
 *   3. **Parity with MCP `list_managed_resources`** — the returned
 *      CFN-form string is what gets forwarded to
 *      `fetchManagedResources(region, resourceType)`, matching the
 *      third-party contract the MCP tool exposes in
 *      `apps/mcp-server/src/tools/list-managed-resources.ts`.
 *
 * @see Story 56-it1-01 — closes HIGH `it56-1-L3-001`.
 * @see Story e92.u.b — closes HIGH `F-A-04` (SNS/EC2/VPC/EventBridge/
 *      CloudWatch/CloudFront service-name shorthands).
 */

import {
  AssigneeError,
  SUPPORTED_TYPES_ARRAY,
  renderSupportedTypesHint,
} from "@assignee/core";

/** CLI-side error code for an unknown `--resource-type` value. */
export const INVALID_RESOURCE_TYPE_CODE = "INVALID_RESOURCE_TYPE" as const;

/**
 * @internal Test-only — emit an ambiguous-shorthand warning (P2-01).
 * Exported so the unit test can spy on the `console.warn` surface
 * without also exercising the whole resolver. Called by
 * `normaliseResourceType` when a HEADLINE_SHORTHANDS hit narrows a
 * multi-type service to just its headline CFN form.
 */
export function warnAmbiguousShorthandIfNeeded(
  shorthand: string,
  resolved: string,
): void {
  const parts = resolved.split("::");
  if (parts.length !== 3) return;
  const service = parts[1]!;
  const siblings = SUPPORTED_TYPES_ARRAY.filter((t) => {
    const p = t.split("::");
    return p[1] === service && t !== resolved;
  });
  if (siblings.length === 0) return;
  // Keep the message terse — stderr only, never blocks the command.
  // Shows the alternative CFN forms the user can pass if they meant
  // one of them.
  const alternatives = siblings.join(", ");
  console.warn(
    `Shorthand "${shorthand}" resolved to ${resolved}, but ${service} also supports: ${alternatives}. Pass the full CFN type if you meant one of those.`,
  );
}

/**
 * Small curated shorthand alias map for the common case where the
 * service name maps to a single "headline" CFN type even though the
 * service owns multiple supported types (e.g. S3 has Bucket AND
 * BucketPolicy; users typing `--resource-type S3` almost always mean
 * Bucket). Keys are case-insensitive shorthand inputs; values must
 * appear in `SUPPORTED_TYPES_ARRAY` (enforced at call time — bogus
 * values simply fall through to the generic validator).
 *
 * Keep this map small and reviewable — adding an entry is a UX
 * decision, not a default. For ambiguous services (EC2 has 10+
 * supported types) users must pass the full CFN form OR the service
 * shorthand added here (e.g. `ec2` → `AWS::EC2::Instance`) which
 * fires the P2-01 ambiguous-shorthand warning so the user is steered
 * to the sibling CFN forms if they meant one of those.
 *
 * Story e92.u.b (F-A-04): added six service-level shorthands — `sns`,
 * `ec2`, `vpc`, `eventbridge`, `cloudwatch`, `cloudfront` — so common
 * user inputs (`--resource-type SNS`, `EC2`, `VPC`, `EventBridge`,
 * `CloudWatch`, `CloudFront`) resolve instead of erroring out.
 * `eventbridge` is a special case: the CFN service is `Events` not
 * `EventBridge`, so step-5 service-name fallback would never fire for
 * this alias.
 */
const HEADLINE_SHORTHANDS: Readonly<Record<string, string>> = {
  s3: "AWS::S3::Bucket",
  lambda: "AWS::Lambda::Function",
  dynamodb: "AWS::DynamoDB::Table",
  sqs: "AWS::SQS::Queue",
  rds: "AWS::RDS::DBInstance",
  iam: "AWS::IAM::Role",
  ecs: "AWS::ECS::Cluster",
  ecr: "AWS::ECR::Repository",
  kms: "AWS::KMS::Key",
  // Story e92.u.b — F-A-04 service-level shorthands.
  sns: "AWS::SNS::Topic",
  ec2: "AWS::EC2::Instance",
  vpc: "AWS::EC2::VPC",
  eventbridge: "AWS::Events::Rule",
  cloudwatch: "AWS::CloudWatch::Alarm",
  cloudfront: "AWS::CloudFront::Distribution",
};

/**
 * Normalise a user-supplied `--resource-type <type>` argument into a
 * canonical CFN type string (e.g. `AWS::S3::Bucket`). Accepts either
 * the full CFN form or a friendly shorthand.
 *
 * Match order (first hit wins, case-insensitive throughout):
 *   1. exact match against `SUPPORTED_TYPES_ARRAY`
 *   2. curated `HEADLINE_SHORTHANDS` (e.g. `S3` → `AWS::S3::Bucket`)
 *   3. final-segment match (`Bucket` → `AWS::S3::Bucket`) when unique
 *   4. tail match (`S3::Bucket` → `AWS::S3::Bucket`)
 *   5. service-name match (`Lambda` → `AWS::Lambda::Function`) when
 *      the service has exactly one supported CFN type
 *
 * Returns `undefined` if no supported type matches.
 *
 * Story 56-it2-04 P2-01: when a curated headline shorthand resolves
 * for a service that owns MORE than one supported CFN type (e.g.
 * `rds` → `AWS::RDS::DBInstance` while `AWS::RDS::DBSubnetGroup` also
 * exists), we emit a one-line `console.warn` hint so a user who
 * expected the other type isn't silently narrowed. The warning never
 * changes the return value — it's additive UX.
 */
export function normaliseResourceType(input: string): string | undefined {
  const trimmed = input.trim();
  if (!trimmed) return undefined;
  const lower = trimmed.toLowerCase();

  // 1. exact CFN match (case-insensitive so `aws::s3::bucket` works too)
  const exact = SUPPORTED_TYPES_ARRAY.find((t) => t.toLowerCase() === lower);
  if (exact) return exact;

  // 2. curated headline-shorthand alias. Filter through
  //    SUPPORTED_TYPES_ARRAY membership so a stale alias doesn't
  //    resolve to a removed CFN type.
  const headline = HEADLINE_SHORTHANDS[lower];
  if (headline && SUPPORTED_TYPES_ARRAY.some((t) => t === headline)) {
    // P2-01 UX warning: service has >1 supported types, but shorthand
    // resolves to just the headline one. Point the user to alternatives
    // so a RDS/DBSubnetGroup query doesn't silently become DBInstance.
    warnAmbiguousShorthandIfNeeded(trimmed, headline);
    return headline;
  }

  // 3. final-segment match — only when exactly one supported type ends
  //    with that segment. Ambiguous matches (e.g. EventBus vs something
  //    else ending in `Bus`) fall through so the user is steered to the
  //    full CFN form via the help hint.
  const finalSegMatches = SUPPORTED_TYPES_ARRAY.filter((t) => {
    const parts = t.split("::");
    return parts[parts.length - 1]?.toLowerCase() === lower;
  });
  if (finalSegMatches.length === 1) return finalSegMatches[0];

  // 4. `<Service>::<Type>` tail match (e.g. `S3::Bucket`).
  const tailMatches = SUPPORTED_TYPES_ARRAY.filter((t) => {
    const parts = t.split("::");
    if (parts.length < 3) return false;
    return `${parts[1]}::${parts[2]}`.toLowerCase() === lower;
  });
  if (tailMatches.length === 1) return tailMatches[0];

  // 5. service-name match (`Lambda` → AWS::Lambda::Function) only
  //    when the service has exactly one supported CFN type. Services
  //    with multiple (e.g. EC2 → VPC / Subnet / Instance / …) stay
  //    unresolved so the user is nudged to the explicit form OR
  //    added to HEADLINE_SHORTHANDS above.
  const serviceMatches = SUPPORTED_TYPES_ARRAY.filter((t) => {
    const parts = t.split("::");
    return parts[1]?.toLowerCase() === lower;
  });
  if (serviceMatches.length === 1) return serviceMatches[0];

  return undefined;
}

/**
 * Validate & normalise the `--resource-type <type>` value. Throws an
 * `AssigneeError` with code `INVALID_RESOURCE_TYPE` if the input does
 * not map to any entry in `SUPPORTED_TYPES_ARRAY`. The error message
 * embeds `renderSupportedTypesHint("cli")` — the SSO-authoritative
 * grouped list — so callers never hardcode a type list inline.
 */
export function resolveResourceTypeFilter(input: string): string {
  const normalised = normaliseResourceType(input);
  if (normalised) return normalised;
  const hint = renderSupportedTypesHint("cli");
  throw new AssigneeError(
    `Unknown --resource-type "${input}".\n\n${hint}`,
    INVALID_RESOURCE_TYPE_CODE,
  );
}
