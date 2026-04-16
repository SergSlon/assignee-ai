/**
 * Timeouts, polling caps, retry intervals. Domain sub-module of the
 * former `config/constants.ts` coupling hub (Story 49.5).
 */

import { EnvVar } from "../../constants/env-vars.js";

/** Maximum number of polls before giving up on delete status.
 *  600 × 2s = 1200s = 20 min. Accommodates RDS (5-15 min), CloudFront
 *  (10-15 min), and NAT Gateway (~3 min) deletion timings. */
export const DESTROY_MAX_POLL_ATTEMPTS = 600;

/** Delay between destroy status polls in milliseconds. */
export const DESTROY_POLL_INTERVAL_MS = 2000;

/** Hard timeout for pricing MCP queries (ms). Non-blocking. */
export const PRICING_TIMEOUT_MS = 3000;

/** Timeout for post-provision security posture checks (ms). */
export const SECURITY_CHECK_TIMEOUT_MS = 5000;

/** 24 hours in ms — used for failure record staleness checks. */
export const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

/** Timeout for pricing lookups during option elicitation (ms). */
export const PRICING_LOOKUP_TIMEOUT_MS = 3000;

/** Timeout for fetching org policy from SaaS API (ms). */
export const ORG_POLICY_FETCH_TIMEOUT_MS = 2000;

/** Delay for optional MCP client init before proceeding with core tools (ms). */
export const MCP_SHUTDOWN_DELAY_MS = 3000;

/** Maximum retries for drift detection resource checks. */
export const DRIFT_MAX_RETRIES = 3;

/** Base delay for drift detection exponential backoff (ms). */
export const DRIFT_RETRY_BASE_DELAY_MS = 200;

/** Maximum jitter added to drift detection retry delay (ms). */
export const DRIFT_RETRY_JITTER_MS = 100;

/** Skip checkpoint files modified within this many minutes during cleanup. */
export const CLEANUP_SKIP_RECENT_MINUTES = 10;

/** Default max age for cache entries (24 hours in ms). */
export const CLEANUP_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/** Threshold for deduplicating memory lock acquisition attempts (ms). */
export const MEMORY_DEDUP_THRESHOLD_MS = 10_000;

/** Maximum iterations for the provisioning loop before aborting. */
export const MAX_PROVISION_LOOPS = 50;

/** Auto-cleanup throttle interval in ms (1 hour). */
export const AUTO_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/** TTL in ms for cached org policy (default 5 minutes, env override). */
export const ORG_POLICY_TTL_MS = parseInt(
  process.env[EnvVar.ASSIGNEE_ORG_POLICY_TTL_MS] ?? "300000",
  10,
);
