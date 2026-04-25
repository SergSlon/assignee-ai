/**
 * W3-03 (Epic 100 Round 5) — OIDC hexagonal port scaffold.
 *
 * Defines the `OIDCPort` interface that any OIDC adapter must implement.
 * Today the only concrete adapter is `InMemoryOIDCAdapter` (fixture-backed,
 * used in tests).
 *
 * Real adapters (Okta / AzureAD / Auth0) defer to Epic 101 (identity-squad
 * hire).  The operator-facing default remains W2 `AWS_PROFILE` SSO;
 * the OIDC tier is a scaffolded enterprise-identity lane.
 */

// ── Claims ─────────────────────────────────────────────────────────────

/**
 * Decoded claims extracted from a validated OIDC access token.
 *
 * The minimal set needed for RBAC; Epic 101 will extend with
 * `groups`, `tenantId`, and custom claims per IdP.
 */
export interface Claims {
  /** Subject identifier (user or service ID). */
  sub: string;
  /** Issuer URL. */
  iss: string;
  /** Audience — the client_id or API this token was issued for. */
  aud: string | string[];
  /** Expiry timestamp (Unix seconds). */
  exp: number;
  /** Issued-at timestamp (Unix seconds). */
  iat: number;
  /** Optional email address. */
  email?: string;
  /** Optional role claim. Epic 101 maps this to `getCurrentRole()`. */
  role?: string;
}

// ── Port interface ─────────────────────────────────────────────────────

export interface OIDCPort {
  /**
   * Validate an access token string.
   *
   * @returns `{ valid: true, claims }` on success, `{ valid: false }` on
   *   any validation failure (expired, invalid signature, unknown issuer).
   */
  validateToken(
    token: string,
  ): Promise<{ valid: true; claims: Claims } | { valid: false }>;

  /**
   * Extract claims from a token without full validation.
   * Returns `undefined` when the token cannot be decoded (e.g. not JWT).
   * Does NOT verify signature or expiry.
   */
  extractClaims(token: string): Claims | undefined;

  /**
   * Exchange a refresh token for a new access + refresh token pair.
   *
   * @throws When the refresh token is expired, revoked, or unrecognised.
   */
  refreshToken(refreshToken: string): Promise<{
    accessToken: string;
    refreshToken: string;
  }>;
}
