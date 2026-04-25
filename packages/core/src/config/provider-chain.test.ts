/**
 * Unit tests for provider-chain.ts — W2-02 / W2-03
 *
 * Tests the resolveOperatorCredentialProvider() function across all priority
 * branches. AWS SDK provider calls are mocked — no actual ~/.aws/config reads.
 *
 * Test matrix rows covered (W2-03):
 *   row-1: env-var-only (AKIA + secret, no session token) → static provider
 *   row-2: session token present → included in static provider
 *   row-3: AWS_PROFILE-only → fromIni() provider returned
 *   row-4: --profile explicit arg → fromIni() used, overrides AWS_PROFILE
 *   row-5: env-var + profile precedence: env-var wins
 *   row-8: cross-region with AWS_PROFILE — source description correct
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// ── Mock @aws-sdk/credential-providers ──────────────────────────────────────
// We intercept the dynamic import so no real ~/.aws/config is read.

const mockFromIni = vi.fn();
const mockFromNodeProviderChain = vi.fn();
const mockFromEnv = vi.fn();

vi.mock("@aws-sdk/credential-providers", () => ({
  fromIni: mockFromIni,
  fromNodeProviderChain: mockFromNodeProviderChain,
  fromEnv: mockFromEnv,
}));

import { resolveOperatorCredentialProvider } from "./provider-chain.js";

const OPERATOR_VARS = [
  "ASSIGNEE_OPERATOR_ACCESS_KEY_ID",
  "ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY",
  "ASSIGNEE_OPERATOR_SESSION_TOKEN",
  "AWS_PROFILE",
  "AWS_REGION",
];

const saved: Record<string, string | undefined> = {};

function scrubEnv(): void {
  for (const key of OPERATOR_VARS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
}

function restoreEnv(): void {
  for (const key of OPERATOR_VARS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
}

describe("resolveOperatorCredentialProvider — provider chain (W2-02/W2-03)", () => {
  beforeEach(() => {
    scrubEnv();
    vi.resetAllMocks();
    // Default mock for fromNodeProviderChain
    mockFromNodeProviderChain.mockReturnValue(async () => ({
      accessKeyId: "AKIANODEPROVIDER0000",
      secretAccessKey: "nodeProviderSecretKey",
    }));
  });
  afterEach(restoreEnv);

  // ── Row 1: env-var-only (AKIA, no session token) ─────────────────────────

  it("row-1: ASSIGNEE_OPERATOR_* set (no session token) → static provider, correct creds", async () => {
    process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
    process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";

    const result = await resolveOperatorCredentialProvider();
    expect(result.source).toMatch(/ASSIGNEE_OPERATOR/);
    const creds = await result.provider();
    expect(creds.accessKeyId).toBe("AKIAIOSFODNN7EXAMPLE");
    expect(creds.secretAccessKey).toBe(
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    );
    expect(creds.sessionToken).toBeUndefined();
    // No SDK provider was used
    expect(mockFromIni).not.toHaveBeenCalled();
    expect(mockFromNodeProviderChain).not.toHaveBeenCalled();
  });

  // ── Row 2: env-var + session token ───────────────────────────────────────

  it("row-2: ASSIGNEE_OPERATOR_* + session token → static provider includes sessionToken", async () => {
    const TOKEN =
      "AQoXnyc4lcK4w4OIaHPGTq6EXAMPLEsessionTOKEN1234567890abcdefghijklmno";
    process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "ASIAIOSFODNN7STSEXAMP";
    process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
      "stsSecretKeyValueExample123456789012345";
    process.env["ASSIGNEE_OPERATOR_SESSION_TOKEN"] = TOKEN;

    const result = await resolveOperatorCredentialProvider();
    const creds = await result.provider();
    expect(creds.sessionToken).toBe(TOKEN);
  });

  // ── Row 3: AWS_PROFILE-only → fromIni() ──────────────────────────────────

  it("row-3: AWS_PROFILE set, no ASSIGNEE_OPERATOR_* → fromIni() provider", async () => {
    process.env["AWS_PROFILE"] = "enterprise-sso";
    const mockProvider = vi.fn().mockResolvedValue({
      accessKeyId: "ASIAIOSFODNN7SSOEXMPL",
      secretAccessKey: "ssoSecretKey123",
      sessionToken: "ssoSessionTokenValue123",
    });
    mockFromIni.mockReturnValue(mockProvider);

    const result = await resolveOperatorCredentialProvider();
    expect(result.source).toContain("enterprise-sso");
    expect(result.profile).toBe("enterprise-sso");
    expect(mockFromIni).toHaveBeenCalledWith({ profile: "enterprise-sso" });
  });

  // ── Row 4: --profile explicit arg ────────────────────────────────────────

  it("row-4: explicit profile arg → fromIni() called with that profile", async () => {
    process.env["AWS_PROFILE"] = "default"; // should be overridden
    const mockProvider = vi.fn().mockResolvedValue({
      accessKeyId: "AKIAIOSFODNN7PROFILE",
      secretAccessKey: "profileSecretKey",
    });
    mockFromIni.mockReturnValue(mockProvider);

    const result = await resolveOperatorCredentialProvider(
      "my-explicit-profile",
    );
    expect(result.source).toContain("my-explicit-profile");
    expect(result.profile).toBe("my-explicit-profile");
    expect(mockFromIni).toHaveBeenCalledWith({
      profile: "my-explicit-profile",
    });
  });

  // ── Row 5: env-var + profile precedence (env-var wins) ───────────────────

  it("row-5: ASSIGNEE_OPERATOR_* set AND AWS_PROFILE set — env-var wins, no fromIni call", async () => {
    process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
    process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
      "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
    process.env["AWS_PROFILE"] = "should-not-be-used";

    const result = await resolveOperatorCredentialProvider();
    expect(result.source).toMatch(/ASSIGNEE_OPERATOR/);
    expect(mockFromIni).not.toHaveBeenCalled();
    const creds = await result.provider();
    expect(creds.accessKeyId).toBe("AKIAIOSFODNN7EXAMPLE");
  });

  // ── Row 8 (W2-03): cross-region with AWS_PROFILE ─────────────────────────

  it("row-8: cross-region with AWS_PROFILE — source description includes profile name", async () => {
    process.env["AWS_PROFILE"] = "eu-west-1-sso";
    process.env["AWS_REGION"] = "eu-west-1";
    mockFromIni.mockReturnValue(
      vi.fn().mockResolvedValue({
        accessKeyId: "AKIAIOSFODNN7EUWEST1",
        secretAccessKey: "euwest1SecretKey",
      }),
    );

    const result = await resolveOperatorCredentialProvider();
    expect(result.source).toContain("eu-west-1-sso");
    expect(result.profile).toBe("eu-west-1-sso");
  });

  // ── Fallback: no creds, no profile → default provider chain ──────────────

  it("no ASSIGNEE_OPERATOR_*, no AWS_PROFILE → fromNodeProviderChain() used", async () => {
    const chainProvider = vi.fn().mockResolvedValue({
      accessKeyId: "AKIANODECHAIN000000",
      secretAccessKey: "nodeChainSecret",
    });
    mockFromNodeProviderChain.mockReturnValue(chainProvider);

    const result = await resolveOperatorCredentialProvider();
    expect(result.source).toContain("default provider chain");
    expect(mockFromNodeProviderChain).toHaveBeenCalled();
    expect(mockFromIni).not.toHaveBeenCalled();
  });
});
