/**
 * CCAPI fallback + redirect + SDK-routable resource types.
 * Types that cannot (or should not) be provisioned via Cloud Control API,
 * and the redirect map pointing them at their supported alternative.
 *
 * Split out of `resource-types.ts` for SRP / file-size compliance.
 */

// ── CCAPI Fallback Types (Story 7.7; narrowed by A6 and A10) ────────────────
// Resource types that cannot be provisioned via Cloud Control API.
// After A10 these are redirect-only types — there is no remaining
// SDK-based create/delete path in this codebase, only friendly
// redirect messages pointing at the supported alternative.

/** All resource types known to have CCAPI gaps. */
export const CCAPI_FALLBACK_TYPES = {
  LAMBDA_PERMISSION: "AWS::Lambda::Permission",
  ELASTICACHE_REPLICATION_GROUP: "AWS::ElastiCache::ReplicationGroup",
} as const;

/** Union of all CCAPI fallback resource type strings. */
export type CcapiFallbackType =
  (typeof CCAPI_FALLBACK_TYPES)[keyof typeof CCAPI_FALLBACK_TYPES];

/**
 * Resource types that can be handled via direct AWS SDK calls (not CCAPI).
 *
 * A10 (2026-04-09): emptied after SNS::Subscription was promoted to
 * first-class. Kept as an empty readonly array so the dispatcher's
 * canHandle() / canDelete() hooks keep compiling.
 */
export const CCAPI_SDK_ROUTABLE_TYPES: readonly string[] = [] as const;

/**
 * Resource types that are not supported and should redirect to an alternative.
 * Key: unsupported resource type, Value: recommended alternative type.
 */
export const CCAPI_REDIRECT_TYPES: Readonly<Record<string, string>> = {
  [CCAPI_FALLBACK_TYPES.LAMBDA_PERMISSION]: "AWS::Lambda::PermissionPolicy",
  [CCAPI_FALLBACK_TYPES.ELASTICACHE_REPLICATION_GROUP]:
    "AWS::ElastiCache::ServerlessCache",
} as const;
