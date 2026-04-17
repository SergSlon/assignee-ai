/**
 * Types shared by every error-message module.
 */

export interface ErrorMessageEntry {
  /** Machine-readable error code for programmatic matching. */
  code: string;
  /** WHAT went wrong — a specific, concise error description. */
  what: string;
  /** WHY it happened — contextual explanation for the user. */
  why: string;
  /** HOW TO FIX — actionable suggestion the user can follow immediately. */
  howToFix: string;
  /** Optional link to documentation or runbook. */
  docLink?: string;
}

/**
 * Live operational context available when an error is being rendered.
 * Fields left undefined are rendered as empty strings so old tests
 * (which call `resolve(err)` with no context) continue to pass — the
 * interpolation is a no-op on absent tokens.
 *
 * See R2-C "N5" / P1-R2-4: error messages were 100% generic — users
 * could not tell which account / region / profile the error came from.
 */
export interface ErrorResolveContext {
  /** Resolved AWS region (e.g. us-east-1). Usually `process.env.AWS_REGION`. */
  region?: string;
  /** 12-digit AWS account ID, if detected via STS GetCallerIdentity. */
  account?: string;
  /** Named profile in use, if AWS_PROFILE is set. */
  profile?: string;
  /** ARN the error relates to, when the caller has resolved one. */
  arn?: string;
  /**
   * True when assignee is running with ASSIGNEE_OPERATOR_* credentials
   * (not AWS_ACCESS_KEY_ID). Some fix hints change wording depending on
   * which credential path the user took.
   */
  operatorCreds?: boolean;
}

export interface FormattedError {
  what: string;
  why: string;
  howToFix: string;
}
