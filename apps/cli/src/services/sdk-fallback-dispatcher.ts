/**
 * SDKFallbackDispatcher — gate for resource types with known CCAPI gaps.
 *
 * Historically this class also drove direct AWS SDK write paths for
 * types that CloudControl could not provision. After A10 there are
 * no remaining SDK-write code paths in this codebase:
 *
 *   - A6  (2026-04-08): Lambda EventSourceMapping + SNS Topic delete
 *                       migrated to CCAPI (live-AWS probe confirmed
 *                       full handler support).
 *   - A10 (2026-04-09): AWS::SNS::Subscription promoted to first-class
 *                       with its own ResourcePlugin. Subscribe /
 *                       Unsubscribe SDK commands removed; CCAPI
 *                       handles the full CRUD lifecycle.
 *
 * The class survives in a slimmer form because the remaining entries
 * in CCAPI_FALLBACK_TYPES (LAMBDA_PERMISSION, ELASTICACHE_REPLICATION_GROUP)
 * are pure redirect types — the resource_provisioner node still asks
 * `dispatcher.isRedirect()` to emit a friendly "use X instead"
 * message before attempting the CloudControl path. `canHandle()` and
 * `canDelete()` are retained as always-false hooks so a future
 * SDK-only promotion wouldn't require re-plumbing the graph node.
 *
 * No AWS SDK client is instantiated here anymore — the class is pure
 * in-memory lookup logic and can be safely constructed without
 * credentials (previously the SNS-client setup required valid
 * access keys which made the class hostile to no-credential flows).
 *
 * @see Story 7.7 — SDK Fallback Dispatcher for CCAPI Gaps
 */

import {
  CCAPI_FALLBACK_TYPES,
  CCAPI_SDK_ROUTABLE_TYPES,
  CCAPI_REDIRECT_TYPES,
} from "@assignee/core";

/** Redirect info returned when a resource type is unsupported but has a known alternative. */
export interface RedirectInfo {
  redirect: true;
  message: string;
}

/**
 * Classifies CCAPI-gap resource types into redirect or no-op.
 *
 * Redirect types (return friendly guidance from isRedirect):
 *   - AWS::Lambda::Permission → use AWS::Lambda::PermissionPolicy
 *   - AWS::ElastiCache::ReplicationGroup → use AWS::ElastiCache::ServerlessCache
 *
 * SDK-routable types (handled by canHandle):
 *   - (none after A10 — empty CCAPI_SDK_ROUTABLE_TYPES)
 */
export class SDKFallbackDispatcher {
  /**
   * Returns true if the given resource type can be handled by direct SDK calls.
   * Always false after A10 — kept as a stable extension hook.
   */
  canHandle(resourceType: string): boolean {
    return (CCAPI_SDK_ROUTABLE_TYPES as readonly string[]).includes(
      resourceType,
    );
  }

  /**
   * Returns redirect info if the resource type is unsupported and has a known alternative.
   * Returns null if the type is not a redirect type.
   */
  isRedirect(resourceType: string): RedirectInfo | null {
    const alternative = CCAPI_REDIRECT_TYPES[resourceType];
    if (!alternative) return null;

    if (resourceType === CCAPI_FALLBACK_TYPES.LAMBDA_PERMISSION) {
      return {
        redirect: true,
        message: `AWS::Lambda::Permission is not supported by CCAPI. Use AWS::Lambda::PermissionPolicy instead.`,
      };
    }

    if (resourceType === CCAPI_FALLBACK_TYPES.ELASTICACHE_REPLICATION_GROUP) {
      return {
        redirect: true,
        message: `ElastiCache ReplicationGroup is not supported. Use AWS::ElastiCache::ServerlessCache for Redis/Memcached.`,
      };
    }

    return {
      redirect: true,
      message: `${resourceType} is not supported by CCAPI. Use ${alternative} instead.`,
    };
  }

  /**
   * Returns true if the given resource type can be deleted by direct SDK calls.
   * Always false after A10. Kept as a stable hook to mirror canHandle().
   */
  canDelete(resourceType: string): boolean {
    return (CCAPI_SDK_ROUTABLE_TYPES as readonly string[]).includes(
      resourceType,
    );
  }
}
