/**
 * Branch-coverage uplift for utils/command-runner/credentials.ts — P066 R10b-01.
 *
 * Covers all 6 conditional branches in resolveCredentials:
 *  1. hasOperatorKey → no-op (already has creds)
 *  2. !hasOperatorKey && hasStandardKey (auto-promote, silent=true)
 *  3. !hasOperatorKey && hasStandardKey with session token (auto-promote)
 *  4. !hasOperatorKey && hasStandardKey, silent=false → writes stderr warning
 *  5. !hasOperatorKey && hasProfile, silent=false → writes stderr warning
 *  6. !hasOperatorKey && !hasProfile → throws ConfigurationError
 *
 * And resolveCredentialsWithProfile:
 *  7. hasOperatorKey already → early return
 *  8. no profile resolved → early return
 *  9. happy path → fromIni resolves + promotes + writes success line
 *  10. happy path silent=true → no stderr write
 *  11. ExpiredTokenException → throws ConfigurationError with sso hint
 *  12. expired via message text → throws ConfigurationError with sso hint
 *  13. non-expiry error → throws ConfigurationError (generic message)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ConfigurationError } from "@assignee/core";

// ──────────────────────────────────────────────────────────────────────────────
// Mock @aws-sdk/credential-providers so resolveCredentialsWithProfile doesn't
// need real AWS creds.
// ──────────────────────────────────────────────────────────────────────────────

const mockFromIni = vi.fn();

vi.mock("@aws-sdk/credential-providers", () => ({
  fromIni: (...args: unknown[]) => mockFromIni(...args),
}));

import {
  resolveCredentials,
  resolveCredentialsWithProfile,
} from "./credentials.js";
import { EnvVar } from "../../constants/env-vars.js";

// ──────────────────────────────────────────────────────────────────────────────
// Env helpers
// ──────────────────────────────────────────────────────────────────────────────

const ENV_KEYS = [
  EnvVar.OPERATOR_ACCESS_KEY,
  EnvVar.OPERATOR_SECRET_KEY,
  EnvVar.OPERATOR_SESSION_TOKEN,
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_PROFILE",
  EnvVar.AWS_PROFILE,
] as const;

let savedEnv: Partial<Record<string, string>> = {};

beforeEach(() => {
  vi.clearAllMocks();
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = savedEnv[key];
    }
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// resolveCredentials
// ══════════════════════════════════════════════════════════════════════════════

describe("resolveCredentials", () => {
  it("is a no-op when ASSIGNEE_OPERATOR_* keys are already present", () => {
    process.env[EnvVar.OPERATOR_ACCESS_KEY] = "AKIAOP123";
    process.env[EnvVar.OPERATOR_SECRET_KEY] = "secret123";
    // Should not throw and should not modify env
    resolveCredentials(true);
    expect(process.env[EnvVar.OPERATOR_ACCESS_KEY]).toBe("AKIAOP123");
  });

  it("auto-promotes AWS_* vars to ASSIGNEE_OPERATOR_* (branch: hasStandardKey)", () => {
    process.env["AWS_ACCESS_KEY_ID"] = "AKIASTANDARD";
    process.env["AWS_SECRET_ACCESS_KEY"] = "standardsecret";

    resolveCredentials(true);

    expect(process.env[EnvVar.OPERATOR_ACCESS_KEY]).toBe("AKIASTANDARD");
    expect(process.env[EnvVar.OPERATOR_SECRET_KEY]).toBe("standardsecret");
  });

  it("also promotes AWS_SESSION_TOKEN when present (branch: hasSessionToken)", () => {
    process.env["AWS_ACCESS_KEY_ID"] = "AKIASESSION";
    process.env["AWS_SECRET_ACCESS_KEY"] = "sessionsecret";
    process.env["AWS_SESSION_TOKEN"] = "token-abc-123";

    resolveCredentials(true);

    expect(process.env[EnvVar.OPERATOR_SESSION_TOKEN]).toBe("token-abc-123");
  });

  it("writes stderr warning when silent=false on AWS_* auto-promote (branch: !silent)", () => {
    process.env["AWS_ACCESS_KEY_ID"] = "AKIANOISY";
    process.env["AWS_SECRET_ACCESS_KEY"] = "noisysecret";

    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    resolveCredentials(false);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("Using AWS_ACCESS_KEY_ID"),
    );
    stderrSpy.mockRestore();
  });

  it("returns without throwing when only AWS_PROFILE is set (branch: hasProfile)", () => {
    process.env["AWS_PROFILE"] = "my-dev-profile";
    // Should not throw
    expect(() => resolveCredentials(true)).not.toThrow();
  });

  it("writes stderr warning for AWS_PROFILE when silent=false (branch: !silent in profile path)", () => {
    process.env["AWS_PROFILE"] = "my-sso-profile";

    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    resolveCredentials(false);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("AWS_PROFILE"),
    );
    stderrSpy.mockRestore();
  });

  it("throws ConfigurationError when no credentials are present at all", () => {
    expect(() => resolveCredentials(true)).toThrow(ConfigurationError);
    expect(() => resolveCredentials(true)).toThrow(
      /No AWS credentials detected/,
    );
  });

  it("non-TTY AWS_* auto-promote warning is ASCII-only (no bytes > 0x7E)", () => {
    process.env["AWS_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
    process.env["AWS_SECRET_ACCESS_KEY"] = "wJalrXUtnFEMI/K7MDENG";

    const captured: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        captured.push(String(chunk));
        return true;
      });
    // Simulate non-TTY
    const origIsTTY = process.stderr.isTTY;
    Object.defineProperty(process.stderr, "isTTY", {
      value: false,
      configurable: true,
    });

    resolveCredentials(false);

    Object.defineProperty(process.stderr, "isTTY", {
      value: origIsTTY,
      configurable: true,
    });
    stderrSpy.mockRestore();

    const output = captured.join("");
    // Must not contain any character outside printable ASCII + newline
    expect(output).toMatch(/^[\x20-\x7E\n]*$/);
    expect(output).toContain("Using AWS_ACCESS_KEY_ID");
  });

  it("non-TTY AWS_PROFILE warning is ASCII-only (no bytes > 0x7E)", () => {
    process.env["AWS_PROFILE"] = "my-dev-profile";

    const captured: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        captured.push(String(chunk));
        return true;
      });
    const origIsTTY = process.stderr.isTTY;
    Object.defineProperty(process.stderr, "isTTY", {
      value: false,
      configurable: true,
    });

    resolveCredentials(false);

    Object.defineProperty(process.stderr, "isTTY", {
      value: origIsTTY,
      configurable: true,
    });
    stderrSpy.mockRestore();

    const output = captured.join("");
    expect(output).toMatch(/^[\x20-\x7E\n]*$/);
    expect(output).toContain("AWS_PROFILE");
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// resolveCredentialsWithProfile
// ══════════════════════════════════════════════════════════════════════════════

describe("resolveCredentialsWithProfile", () => {
  it("is a no-op when ASSIGNEE_OPERATOR_* keys are already present", async () => {
    process.env[EnvVar.OPERATOR_ACCESS_KEY] = "AKIAOP123";
    process.env[EnvVar.OPERATOR_SECRET_KEY] = "secret123";

    await resolveCredentialsWithProfile("some-profile");

    // fromIni should never be called
    expect(mockFromIni).not.toHaveBeenCalled();
  });

  it("is a no-op when no profile can be resolved (branch: !resolvedProfile)", async () => {
    // No profile arg, no AWS_PROFILE, no custom env var
    await resolveCredentialsWithProfile(undefined, true);
    expect(mockFromIni).not.toHaveBeenCalled();
  });

  it("resolves profile from EnvVar.AWS_PROFILE env when arg is absent", async () => {
    process.env[EnvVar.AWS_PROFILE] = "env-var-profile";
    const mockProvider = vi.fn().mockResolvedValue({
      accessKeyId: "AKIARESOLVED",
      secretAccessKey: "resolved-secret",
    });
    mockFromIni.mockReturnValue(mockProvider);

    await resolveCredentialsWithProfile(undefined, true);

    expect(mockFromIni).toHaveBeenCalledWith({ profile: "env-var-profile" });
    expect(process.env[EnvVar.OPERATOR_ACCESS_KEY]).toBe("AKIARESOLVED");
  });

  it("resolves profile from AWS_PROFILE env when arg and custom env are absent", async () => {
    process.env["AWS_PROFILE"] = "aws-env-profile";
    const mockProvider = vi.fn().mockResolvedValue({
      accessKeyId: "AKIAFROMAWSPROFILE",
      secretAccessKey: "aws-profile-secret",
    });
    mockFromIni.mockReturnValue(mockProvider);

    await resolveCredentialsWithProfile(undefined, true);

    expect(process.env[EnvVar.OPERATOR_ACCESS_KEY]).toBe("AKIAFROMAWSPROFILE");
  });

  it("promotes sessionToken when returned by provider (branch: creds.sessionToken)", async () => {
    process.env["AWS_PROFILE"] = "sso-profile";
    const mockProvider = vi.fn().mockResolvedValue({
      accessKeyId: "AKIASSO",
      secretAccessKey: "sso-secret",
      sessionToken: "sso-session-token",
    });
    mockFromIni.mockReturnValue(mockProvider);

    await resolveCredentialsWithProfile(undefined, true);

    expect(process.env[EnvVar.OPERATOR_SESSION_TOKEN]).toBe(
      "sso-session-token",
    );
  });

  it("writes success line to stderr when silent=false (branch: !silent after success)", async () => {
    process.env["AWS_PROFILE"] = "verbose-profile";
    const mockProvider = vi.fn().mockResolvedValue({
      accessKeyId: "AKIAV",
      secretAccessKey: "vsecret",
    });
    mockFromIni.mockReturnValue(mockProvider);

    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    await resolveCredentialsWithProfile(undefined, false);
    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("Resolved credentials"),
    );
    stderrSpy.mockRestore();
  });

  it("non-TTY resolved-profile success write is ASCII-only (no bytes > 0x7E)", async () => {
    process.env["AWS_PROFILE"] = "ascii-check-profile";
    const mockProvider = vi.fn().mockResolvedValue({
      accessKeyId: "AKIAIOSFODNN7EXAMPLE",
      secretAccessKey: "wJalrXUtnFEMI/K7MDENG",
    });
    mockFromIni.mockReturnValue(mockProvider);

    const captured: string[] = [];
    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((chunk) => {
        captured.push(String(chunk));
        return true;
      });
    const origIsTTY = process.stderr.isTTY;
    Object.defineProperty(process.stderr, "isTTY", {
      value: false,
      configurable: true,
    });

    await resolveCredentialsWithProfile(undefined, false);

    Object.defineProperty(process.stderr, "isTTY", {
      value: origIsTTY,
      configurable: true,
    });
    stderrSpy.mockRestore();

    const output = captured.join("");
    expect(output).toMatch(/^[\x20-\x7E\n]*$/);
    expect(output).toContain("Resolved credentials");
  });

  it("throws ConfigurationError with SSO hint on ExpiredTokenException", async () => {
    process.env["AWS_PROFILE"] = "expired-sso";
    const ssoError = new Error("The security token has expired");
    (ssoError as Error & { name: string }).name = "ExpiredTokenException";
    const mockProvider = vi.fn().mockRejectedValue(ssoError);
    mockFromIni.mockReturnValue(mockProvider);

    await expect(
      resolveCredentialsWithProfile(undefined, true),
    ).rejects.toThrow(ConfigurationError);
    await expect(
      resolveCredentialsWithProfile(undefined, true),
    ).rejects.toThrow(/aws sso login/);
  });

  it("throws ConfigurationError with SSO hint when error name is ExpiredToken", async () => {
    process.env["AWS_PROFILE"] = "expired-profile";
    const expiredError = new Error("Token expired");
    (expiredError as Error & { name: string }).name = "ExpiredToken";
    const mockProvider = vi.fn().mockRejectedValue(expiredError);
    mockFromIni.mockReturnValue(mockProvider);

    await expect(
      resolveCredentialsWithProfile(undefined, true),
    ).rejects.toThrow(/aws sso login/);
  });

  it("throws ConfigurationError with SSO hint when message contains 'expired'", async () => {
    process.env["AWS_PROFILE"] = "sso-expired-msg";
    const msgError = new Error("credential has expired please refresh");
    const mockProvider = vi.fn().mockRejectedValue(msgError);
    mockFromIni.mockReturnValue(mockProvider);

    await expect(
      resolveCredentialsWithProfile(undefined, true),
    ).rejects.toThrow(/aws sso login/);
  });

  it("throws ConfigurationError with SSO hint when message contains 'sso session'", async () => {
    process.env["AWS_PROFILE"] = "sso-session-expired";
    const ssoSessionError = new Error("sso session token is not valid");
    const mockProvider = vi.fn().mockRejectedValue(ssoSessionError);
    mockFromIni.mockReturnValue(mockProvider);

    await expect(
      resolveCredentialsWithProfile(undefined, true),
    ).rejects.toThrow(/aws sso login/);
  });

  it("throws ConfigurationError with SSO hint when message contains 'token has expired'", async () => {
    process.env["AWS_PROFILE"] = "token-expired";
    const tokenError = new Error("the token has expired");
    const mockProvider = vi.fn().mockRejectedValue(tokenError);
    mockFromIni.mockReturnValue(mockProvider);

    await expect(
      resolveCredentialsWithProfile(undefined, true),
    ).rejects.toThrow(/aws sso login/);
  });

  it("throws ConfigurationError with generic message for non-expiry errors (branch: !isExpiry)", async () => {
    process.env["AWS_PROFILE"] = "bad-profile";
    const genericError = new Error("Profile not found in ~/.aws/config");
    const mockProvider = vi.fn().mockRejectedValue(genericError);
    mockFromIni.mockReturnValue(mockProvider);

    await expect(
      resolveCredentialsWithProfile(undefined, true),
    ).rejects.toThrow(ConfigurationError);
    await expect(
      resolveCredentialsWithProfile(undefined, true),
    ).rejects.toThrow(/Failed to resolve credentials/);
  });

  it("uses the explicit profile arg rather than env var when both are set", async () => {
    process.env["AWS_PROFILE"] = "env-profile";
    const mockProvider = vi.fn().mockResolvedValue({
      accessKeyId: "AKIAEXPLICIT",
      secretAccessKey: "explicit-secret",
    });
    mockFromIni.mockReturnValue(mockProvider);

    await resolveCredentialsWithProfile("explicit-profile", true);

    expect(mockFromIni).toHaveBeenCalledWith({ profile: "explicit-profile" });
  });

  it("wraps non-Error throws in ConfigurationError", async () => {
    process.env["AWS_PROFILE"] = "string-throw-profile";
    const mockProvider = vi.fn().mockRejectedValue("just a string error");
    mockFromIni.mockReturnValue(mockProvider);

    await expect(
      resolveCredentialsWithProfile(undefined, true),
    ).rejects.toThrow(ConfigurationError);
  });
});
