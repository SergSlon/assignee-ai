/**
 * Unit tests for sso-refresh.ts — W2-02 / W2-03
 *
 * Covers row-6 (invalid session token) and row-7 (expired SSO) from the
 * W2-03 test matrix, plus the wrapSsoExpiryError helper used in command handlers.
 */

import { describe, it, expect } from "vitest";
import {
  isSsoExpiryError,
  buildSsoRefreshHint,
  wrapSsoExpiryError,
} from "./sso-refresh.js";

// ── Helper to create SDK-style errors ────────────────────────────────────────

function makeAwsSdkError(
  name: string,
  message = "test error",
): Error & {
  name: string;
  $metadata?: { httpStatusCode: number };
} {
  const err = new Error(message) as Error & {
    name: string;
    $metadata?: { httpStatusCode: number };
  };
  err.name = name;
  return err;
}

function makeHttpError(status: number): Error & {
  $metadata: { httpStatusCode: number };
} {
  const err = new Error("HTTP error") as Error & {
    $metadata: { httpStatusCode: number };
  };
  err.name = "HttpError";
  err.$metadata = { httpStatusCode: status };
  return err;
}

// ── isSsoExpiryError ─────────────────────────────────────────────────────────

describe("isSsoExpiryError", () => {
  it("returns true for ExpiredTokenException (AWS SDK v3 name)", () => {
    expect(isSsoExpiryError(makeAwsSdkError("ExpiredTokenException"))).toBe(
      true,
    );
  });

  it("returns true for ExpiredToken", () => {
    expect(isSsoExpiryError(makeAwsSdkError("ExpiredToken"))).toBe(true);
  });

  it("returns true for TokenRefreshRequired", () => {
    expect(isSsoExpiryError(makeAwsSdkError("TokenRefreshRequired"))).toBe(
      true,
    );
  });

  it("returns true for InvalidClientTokenId", () => {
    expect(isSsoExpiryError(makeAwsSdkError("InvalidClientTokenId"))).toBe(
      true,
    );
  });

  it("returns true for HTTP 401", () => {
    expect(isSsoExpiryError(makeHttpError(401))).toBe(true);
  });

  it("returns true for HTTP 403", () => {
    expect(isSsoExpiryError(makeHttpError(403))).toBe(true);
  });

  it("returns true for message containing 'expired token'", () => {
    const err = new Error(
      "The security token included in the request is expired",
    );
    expect(isSsoExpiryError(err)).toBe(true);
  });

  it("returns true for SSO session expired message", () => {
    const err = new Error(
      "The SSO session associated with this profile has expired",
    );
    expect(isSsoExpiryError(err)).toBe(true);
  });

  it("returns false for AccessDenied (not expiry)", () => {
    expect(
      isSsoExpiryError(
        makeAwsSdkError("AccessDeniedException", "AccessDenied"),
      ),
    ).toBe(false);
  });

  it("returns false for generic Error", () => {
    expect(isSsoExpiryError(new Error("network timeout"))).toBe(false);
  });

  it("returns false for non-Error values", () => {
    expect(isSsoExpiryError("a string")).toBe(false);
    expect(isSsoExpiryError(null)).toBe(false);
    expect(isSsoExpiryError(undefined)).toBe(false);
    expect(isSsoExpiryError(42)).toBe(false);
  });
});

// ── buildSsoRefreshHint ───────────────────────────────────────────────────────

describe("buildSsoRefreshHint", () => {
  it("includes aws sso login command with profile when provided", () => {
    const hint = buildSsoRefreshHint("enterprise-sso", "token expired");
    expect(hint).toContain("aws sso login --profile enterprise-sso");
  });

  it("includes export-credentials command with profile", () => {
    const hint = buildSsoRefreshHint("enterprise-sso", "token expired");
    expect(hint).toContain("--profile enterprise-sso");
  });

  it("includes the original error message", () => {
    const hint = buildSsoRefreshHint(
      "my-profile",
      "ExpiredTokenException: token expired at 2026-01-01",
    );
    expect(hint).toContain("ExpiredTokenException");
  });

  it("works without a profile (generic instructions)", () => {
    const hint = buildSsoRefreshHint(undefined, "token expired");
    expect(hint).toContain("aws sso login");
    expect(hint).not.toContain("--profile undefined");
  });
});

// ── wrapSsoExpiryError ────────────────────────────────────────────────────────

describe("wrapSsoExpiryError (W2-03 row-6/row-7)", () => {
  it("row-7: wraps ExpiredTokenException with SsoSessionExpiredError", () => {
    const original = makeAwsSdkError(
      "ExpiredTokenException",
      "session expired",
    );
    const wrapped = wrapSsoExpiryError(original, "my-profile");
    expect(wrapped.name).toBe("SsoSessionExpiredError");
    expect(wrapped.message).toContain("aws sso login --profile my-profile");
    expect(wrapped.message).toContain("session expired");
  });

  it("re-throws non-expiry errors unchanged (name preserved)", () => {
    const original = makeAwsSdkError("AccessDeniedException", "denied");
    const result = wrapSsoExpiryError(original, "my-profile");
    expect(result).toBe(original);
  });

  it("handles non-Error thrown values gracefully", () => {
    const result = wrapSsoExpiryError("raw string error", "profile");
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toContain("raw string error");
  });
});
