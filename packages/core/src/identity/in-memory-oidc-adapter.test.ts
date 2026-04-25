/**
 * W3-03 — In-memory OIDC adapter tests.
 *
 * Covers: valid token, expired token, invalid signature (unknown token),
 * refresh round-trip, extractClaims.
 */

import { describe, it, expect } from "vitest";
import {
  InMemoryOIDCAdapter,
  buildTestClaims,
} from "./in-memory-oidc-adapter.js";

// ── Fixtures ─────────────────────────────────────────────────────────────

const nowSeconds = Math.floor(Date.now() / 1000);

const validClaims = buildTestClaims({
  sub: "user-123",
  iss: "https://example.okta.com",
  aud: "assignee-cli",
  email: "alice@example.com",
  role: "operator",
  // exp defaults to 1h from now — valid.
});

const expiredClaims = buildTestClaims({
  sub: "user-456",
  iss: "https://example.okta.com",
  aud: "assignee-cli",
  exp: nowSeconds - 3600, // 1 hour in the past — expired.
  iat: nowSeconds - 7200,
});

// ── validateToken ─────────────────────────────────────────────────────────

describe("InMemoryOIDCAdapter.validateToken", () => {
  it("returns valid:true with claims for a known non-expired token", async () => {
    const adapter = new InMemoryOIDCAdapter({
      tokens: { "valid-token": validClaims },
    });
    const result = await adapter.validateToken("valid-token");
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.claims.sub).toBe("user-123");
      expect(result.claims.role).toBe("operator");
    }
  });

  it("returns valid:false for an unknown token (invalid signature)", async () => {
    const adapter = new InMemoryOIDCAdapter({
      tokens: { "valid-token": validClaims },
    });
    const result = await adapter.validateToken("unknown-token");
    expect(result.valid).toBe(false);
  });

  it("returns valid:false for an expired token", async () => {
    const adapter = new InMemoryOIDCAdapter({
      tokens: { "expired-token": expiredClaims },
    });
    const result = await adapter.validateToken("expired-token");
    expect(result.valid).toBe(false);
  });

  it("returns valid:false when no tokens are configured", async () => {
    const adapter = new InMemoryOIDCAdapter();
    const result = await adapter.validateToken("any-token");
    expect(result.valid).toBe(false);
  });
});

// ── extractClaims ─────────────────────────────────────────────────────────

describe("InMemoryOIDCAdapter.extractClaims", () => {
  it("returns claims for a known token without checking expiry", () => {
    const adapter = new InMemoryOIDCAdapter({
      tokens: {
        "expired-token": expiredClaims,
        "valid-token": validClaims,
      },
    });
    // extractClaims should return even for expired tokens (no expiry check).
    const claims = adapter.extractClaims("expired-token");
    expect(claims).toBeDefined();
    expect(claims?.sub).toBe("user-456");
  });

  it("returns undefined for an unknown token", () => {
    const adapter = new InMemoryOIDCAdapter({
      tokens: { "valid-token": validClaims },
    });
    expect(adapter.extractClaims("nonexistent")).toBeUndefined();
  });
});

// ── refreshToken ──────────────────────────────────────────────────────────

describe("InMemoryOIDCAdapter.refreshToken", () => {
  it("returns a new access token for a known refresh token", async () => {
    const newAccessClaims = buildTestClaims({
      sub: "user-123",
      iss: "https://example.okta.com",
      aud: "assignee-cli",
    });
    const adapter = new InMemoryOIDCAdapter({
      tokens: {
        "valid-token": validClaims,
        "new-access-token": newAccessClaims,
      },
      refreshPairs: { "refresh-abc": "new-access-token" },
    });

    const result = await adapter.refreshToken("refresh-abc");
    expect(result.accessToken).toBe("new-access-token");
    expect(result.refreshToken).toBe("refreshed-refresh-abc");
  });

  it("throws for an unknown or expired refresh token", async () => {
    const adapter = new InMemoryOIDCAdapter({
      refreshPairs: { "refresh-abc": "new-token" },
    });
    await expect(adapter.refreshToken("unknown-refresh")).rejects.toThrow();
  });

  it("throws when no refresh pairs are configured", async () => {
    const adapter = new InMemoryOIDCAdapter();
    await expect(adapter.refreshToken("any-refresh")).rejects.toThrow();
  });
});

// ── buildTestClaims ───────────────────────────────────────────────────────

describe("buildTestClaims", () => {
  it("sets exp to 1h from now by default", () => {
    const claims = buildTestClaims({
      sub: "s",
      iss: "https://i",
      aud: "a",
    });
    const expectedMin = Math.floor(Date.now() / 1000) + 3500;
    const expectedMax = Math.floor(Date.now() / 1000) + 3700;
    expect(claims.exp).toBeGreaterThanOrEqual(expectedMin);
    expect(claims.exp).toBeLessThanOrEqual(expectedMax);
  });

  it("allows overriding exp", () => {
    const claims = buildTestClaims({
      sub: "s",
      iss: "https://i",
      aud: "a",
      exp: 0,
    });
    expect(claims.exp).toBe(0);
  });

  it("includes all required OIDC fields", () => {
    const claims = buildTestClaims({ sub: "u", iss: "https://i", aud: "a" });
    expect(claims.sub).toBe("u");
    expect(claims.iss).toBe("https://i");
    expect(claims.aud).toBe("a");
    expect(typeof claims.exp).toBe("number");
    expect(typeof claims.iat).toBe("number");
  });
});
