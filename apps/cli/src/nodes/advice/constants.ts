/**
 * Constants for advice advisors — no magic strings or numbers.
 *
 * Story 46.6 (2026-04-12): the instance-family tables (ARM equivalents,
 * Spot eligibility, RDS large-class detection, RDS budget alternatives)
 * moved to their own registry at `../../constants/instance-family-registry.ts`
 * so new AWS instance families can be added without editing this advisor
 * module. Re-exported here for backward compatibility — every existing
 * import of these four symbols continues to resolve through this file.
 *
 * @see Story 40.4, 40.5, 40.6 — original advisor introductions
 * @see Story 46.6 — registry extraction
 */

// ── Cost advisor constants ──────────────────────────────────────────────────

export {
  ARM_EQUIVALENTS,
  SPOT_ELIGIBLE_PREFIXES,
  RDS_LARGE_CLASS_PREFIXES,
  RDS_BUDGET_ALTERNATIVES,
} from "../../constants/instance-family-registry.js";

/** Lambda memory threshold (MB) above which we suggest optimization. */
export const LAMBDA_MEMORY_OPTIMIZATION_THRESHOLD_MB = 512;

// ── Security advisor constants ──────────────────────────────────────────────

/** Well-known ports for security analysis. */
export const Port = {
  SSH: 22,
  HTTPS: 443,
} as const;

/** CIDR block representing "open to the entire internet". */
export const CIDR_ALL_IPV4 = "0.0.0.0/0";

/** IMDSv2 enforcement value. */
export const IMDSV2_REQUIRED = "required";

/** User intent patterns indicating production usage. */
export const PRODUCTION_INTENT_PATTERN = /\b(prod|production)\b/i;

// ── Advice generator constants ──────────────────────────────────────────────

/** Maximum number of advice hints to return. */
export const MAX_ADVICE_HINTS = 5;

/** Max tokens for the advice LLM call — keep cost under $0.03/invocation. */
export const ADVICE_LLM_MAX_TOKENS = 512;

// ── Display constants ───────────────────────────────────────────────────────

/** Advice hint icons. */
export const AdviceIcon = {
  SECURITY_OK: "\u{1F512}",
  WARNING: "\u26A0\uFE0F",
  COST: "\u{1F4B0}",
  ARCHITECTURE: "\u{1F3D7}\uFE0F",
} as const;
