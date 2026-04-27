/**
 * W3-03 (Epic 100 Round 5) — In-memory OIDC adapter (fixture-backed).
 *
 * Implements `OIDCPort` for unit testing and the scaffold wave.  Does NOT
 * perform real cryptographic signature verification — it simply looks up
 * tokens and refresh tokens in the fixture maps provided at construction.
 *
 * Real Okta / AzureAD / Auth0 adapters defer to Epic 101.
 *
 * Usage:
 *   const adapter = new InMemoryOIDCAdapter({
 *     tokens: { "valid-token": { ...claims } },
 *     refreshPairs: { "refresh-abc": "new-access-xyz" },
 *   });
 */

import type { Claims, OIDCPort } from "../ports/oidc-port.js";

// ── Fixture shapes ─────────────────────────────────────────────────────

export interface InMemoryOIDCAdapterOptions {
  /**
   * Map of `token → Claims`. A token present in this map is considered
   * valid unless `claims.exp < Date.now() / 1000`.
   */
  tokens?: Record<string, Claims>;

  /**
   * Map of `refreshToken → newAccessToken`. When a refresh is requested,
   * the new access token must also appear in `tokens`.
   */
  refreshPairs?: Record<string, string>;
}

// ── Adapter ────────────────────────────────────────────────────────────

export class InMemoryOIDCAdapter implements OIDCPort {
  private readonly tokens: ReadonlyMap<string, Claims>;
  private readonly refreshPairs: ReadonlyMap<string, string>;

  constructor(options: InMemoryOIDCAdapterOptions = {}) {
    this.tokens = new Map(Object.entries(options.tokens ?? {}));
    this.refreshPairs = new Map(Object.entries(options.refreshPairs ?? {}));
  }

  async validateToken(
    token: string,
  ): Promise<{ valid: true; claims: Claims } | { valid: false }> {
    const claims = this.tokens.get(token);
    if (!claims) return { valid: false };

    // Check expiry (Unix seconds).
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (claims.exp < nowSeconds) return { valid: false };

    return { valid: true, claims };
  }

  extractClaims(token: string): Claims | undefined {
    return this.tokens.get(token);
  }

  async refreshToken(refreshToken: string): Promise<{
    accessToken: string;
    refreshToken: string;
  }> {
    const newAccessToken = this.refreshPairs.get(refreshToken);
    if (!newAccessToken) {
      throw new Error(
        `InMemoryOIDCAdapter: unknown or expired refresh token "${refreshToken}"`,
      );
    }
    // In a real adapter, the refresh token would be rotated.
    // For tests, we return a predictable new refresh token.
    return {
      accessToken: newAccessToken,
      refreshToken: `refreshed-${refreshToken}`,
    };
  }
}

// ── Convenience fixture builder ────────────────────────────────────────

/**
 * Build a minimal `Claims` object for test fixtures.
 * `exp` defaults to 1 hour from now; `iat` to now.
 */
export function buildTestClaims(
  overrides: Partial<Claims> & { sub: string; iss: string; aud: string },
): Claims {
  const nowSeconds = Math.floor(Date.now() / 1000);
  return {
    exp: nowSeconds + 3600,
    iat: nowSeconds,
    ...overrides,
  };
}
