/**
 * Shared types for the destroy_resource tool sub-modules.
 */

export interface ResolvedResource {
  arn: string;
  resourceType: string;
  region: string;
  identifier: string;
}

export interface PollResult {
  success: boolean;
  message?: string;
}

/** CloudControl HandlerErrorCode for "resource does not exist". */
export const CCAPI_NOT_FOUND_ERROR_CODE = "NotFound";

/** @see DESTROY_MAX_POLL_ATTEMPTS in apps/cli/src/config/constants.ts — keep in sync */
export const MAX_POLL_ATTEMPTS = 60;
/** Extended attempts for slow deletes (RDS, NatGw). */
export const EXTENDED_POLL_ATTEMPTS = 300;
/** @see DESTROY_POLL_INTERVAL_MS in apps/cli/src/config/constants.ts — keep in sync */
export const POLL_INTERVAL_MS = 2_000;

export const MAX_RESOLVE_RETRIES = 4;
export const RESOLVE_RETRY_DELAY_MS = 5_000;
