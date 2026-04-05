/**
 * Constants for advice advisors — no magic strings or numbers.
 *
 * @see Story 40.4, 40.5, 40.6
 */

// ── Cost advisor constants ──────────────────────────────────────────────────

/** Instance type family prefix → ARM (Graviton) equivalent prefix. */
export const ARM_EQUIVALENTS: Record<string, string> = {
  "t3.": "t4g.",
  "m5.": "m6g.",
  "c5.": "c6g.",
};

/** Instance type prefixes eligible for Spot Instance suggestion. */
export const SPOT_ELIGIBLE_PREFIXES = ["t3.", "t4g."] as const;

/** RDS instance class prefixes considered "large" (suggest downgrade for non-prod). */
export const RDS_LARGE_CLASS_PREFIXES = ["db.r5.", "db.r6g."] as const;

/** RDS instance class suggested as cheaper alternative. */
export const RDS_BUDGET_ALTERNATIVES = "db.t3.medium or db.t4g.medium";

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
