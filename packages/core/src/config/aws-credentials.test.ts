/**
 * Unit tests for AWS credential resolution helpers.
 *
 * Covers:
 *  - M-S6: stable error message (no cwd heuristic)
 *  - M-S7: whitespace-only env vars rejected
 *  - M-S8: availableRoles() / envVarsForRole() single source of truth
 *  - W2-01: ASSIGNEE_OPERATOR_SESSION_TOKEN wired through resolver
 *  - W2-03: 8-row credential resolver test matrix
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  ASSIGNEE_ROLES,
  availableRoles,
  envVarsForRole,
  hasAssigneeCredentials,
  InvalidSessionTokenError,
  MissingAssigneeCredentialsError,
  requireAssigneeCredentials,
  tryAssigneeCredentials,
} from "./aws-credentials.js";
import { readFileSync } from "fs";
import { join } from "path";

const ALL_VARS = [
  "ASSIGNEE_OPERATOR_ACCESS_KEY_ID",
  "ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY",
  "ASSIGNEE_OPERATOR_SESSION_TOKEN",
  "ASSIGNEE_READER_ACCESS_KEY_ID",
  "ASSIGNEE_READER_SECRET_ACCESS_KEY",
  "ASSIGNEE_READER_SESSION_TOKEN",
  "ASSIGNEE_AUDITOR_ACCESS_KEY_ID",
  "ASSIGNEE_AUDITOR_SECRET_ACCESS_KEY",
  "ASSIGNEE_AUDITOR_SESSION_TOKEN",
];

const saved: Record<string, string | undefined> = {};

function scrubEnv(): void {
  for (const key of ALL_VARS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
}

function restoreEnv(): void {
  for (const key of ALL_VARS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
}

describe("aws-credentials helpers", () => {
  beforeEach(scrubEnv);
  afterEach(restoreEnv);

  // ── envVarsForRole / ASSIGNEE_ROLES (M-S8) ───────────────────────────────

  describe("envVarsForRole", () => {
    it("returns the documented var names for operator", () => {
      expect(envVarsForRole("operator")).toEqual({
        accessKey: "ASSIGNEE_OPERATOR_ACCESS_KEY_ID",
        secretKey: "ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY",
      });
    });

    it("returns the documented var names for reader", () => {
      expect(envVarsForRole("reader")).toEqual({
        accessKey: "ASSIGNEE_READER_ACCESS_KEY_ID",
        secretKey: "ASSIGNEE_READER_SECRET_ACCESS_KEY",
      });
    });

    it("returns the documented var names for auditor", () => {
      expect(envVarsForRole("auditor")).toEqual({
        accessKey: "ASSIGNEE_AUDITOR_ACCESS_KEY_ID",
        secretKey: "ASSIGNEE_AUDITOR_SECRET_ACCESS_KEY",
      });
    });

    it("ASSIGNEE_ROLES enumerates all 3 roles", () => {
      expect(ASSIGNEE_ROLES).toEqual(["operator", "reader", "auditor"]);
    });
  });

  // ── availableRoles (M-S8) ────────────────────────────────────────────────

  describe("availableRoles", () => {
    it("returns empty array when no env vars are set", () => {
      expect(availableRoles()).toEqual([]);
    });

    it("returns just operator when only operator env vars are set", () => {
      process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
      process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
        "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
      expect(availableRoles()).toEqual(["operator"]);
    });

    it("returns operator and reader when both pairs are set", () => {
      process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
      process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
        "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
      process.env["ASSIGNEE_READER_ACCESS_KEY_ID"] = "AKIAJOHNDOECODE0EXMPL";
      process.env["ASSIGNEE_READER_SECRET_ACCESS_KEY"] =
        "wJalrXUtnFEMI/K7MDENG/bPxRfiCYREADERKEY";
      expect(availableRoles()).toEqual(["operator", "reader"]);
    });

    it("ignores roles where only the access key (not secret) is set", () => {
      process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
      // Secret missing
      expect(availableRoles()).toEqual([]);
    });
  });

  // ── M-S7: whitespace-only env vars rejected ──────────────────────────────

  describe("requireAssigneeCredentials — whitespace handling", () => {
    it("throws when access key is whitespace-only", () => {
      process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "   ";
      process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
        "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
      expect(() => requireAssigneeCredentials("operator")).toThrow(
        MissingAssigneeCredentialsError,
      );
    });

    it("throws when secret key is whitespace-only", () => {
      process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
      process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] = "   \t\n  ";
      expect(() => requireAssigneeCredentials("operator")).toThrow(
        MissingAssigneeCredentialsError,
      );
    });

    it("trims surrounding whitespace from valid credentials", () => {
      process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] =
        "  AKIAIOSFODNN7EXAMPLE  ";
      process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
        "  wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY  ";
      const creds = requireAssigneeCredentials("operator");
      expect(creds.accessKeyId).toBe("AKIAIOSFODNN7EXAMPLE");
      expect(creds.secretAccessKey).toBe(
        "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      );
    });

    it("accepts ASIA-prefixed STS session keys", () => {
      process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "ASIAIOSFODNN7STSEXAMP";
      process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
        "stsSecretKeyValueExample123456789012345";
      const creds = requireAssigneeCredentials("operator");
      expect(creds.accessKeyId).toBe("ASIAIOSFODNN7STSEXAMP");
    });

    it("tryAssigneeCredentials returns undefined for whitespace-only values", () => {
      process.env["ASSIGNEE_READER_ACCESS_KEY_ID"] = "   ";
      process.env["ASSIGNEE_READER_SECRET_ACCESS_KEY"] = "   ";
      expect(tryAssigneeCredentials("reader")).toBeUndefined();
      expect(hasAssigneeCredentials("reader")).toBe(false);
    });
  });

  // ── M-S6: stable error message (no cwd heuristic) ───────────────────────

  describe("MissingAssigneeCredentialsError", () => {
    it("includes the env var names and the stable .env hint", () => {
      try {
        requireAssigneeCredentials("operator");
        expect.fail("expected requireAssigneeCredentials to throw");
      } catch (err) {
        expect(err).toBeInstanceOf(MissingAssigneeCredentialsError);
        const message = (err as Error).message;
        expect(message).toContain("ASSIGNEE_OPERATOR_ACCESS_KEY_ID");
        expect(message).toContain("ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY");
        expect(message).toContain(".env");
        // M-S6: must NOT branch on cwd, so neither path-segment is mentioned
        expect(message).not.toContain("assignee.ai/.env");
        // D5 (UX coherence): the helper error must surface the AWS_*
        // fallback that command-runner actually honors, otherwise the
        // user sees three contradictory credential stories.
        expect(message).toContain("AWS_ACCESS_KEY_ID");
        expect(message).toContain("AWS_SECRET_ACCESS_KEY");
        expect(message).toContain("auto-promoted");
        // D5: the old "intentionally bypassed" wording was misleading
        // because command-runner DOES auto-promote AWS_* env vars.
        expect(message).not.toContain("intentionally bypassed");
      }
    });

    it("error message is identical regardless of process.cwd()", () => {
      // M-S6: the error message must NOT branch on process.cwd() — verify
      // by swapping cwd and confirming the message stays byte-for-byte equal.
      const originalCwd = process.cwd;
      const captures: string[] = [];
      for (const fakeCwd of [
        "/tmp/somewhere/else",
        "/Users/dev/projects/assignee.ai/apps/cli",
        "/var/lib/something",
      ]) {
        (process.cwd as unknown as () => string) = () => fakeCwd;
        try {
          requireAssigneeCredentials("operator");
        } catch (err) {
          captures.push((err as Error).message);
        }
      }
      process.cwd = originalCwd;

      expect(captures).toHaveLength(3);
      expect(new Set(captures).size).toBe(1);
      expect(captures[0]).toContain(
        "in your environment (or in the .env file at the project root)",
      );
    });
  });

  // ── W2-01: ASSIGNEE_OPERATOR_SESSION_TOKEN (Epic 100) ────────────────────

  describe("requireAssigneeCredentials — session token (W2-01)", () => {
    const VALID_KEY = "ASIAIOSFODNN7STSEXAMP";
    const VALID_SECRET = "stsSecretKeyValueExample123456789012345";
    const VALID_TOKEN =
      // Real STS session tokens are typically 100–1000+ chars (base64-encoded
      // blob). This fixture is ≥ 100 chars (SEC-031: MIN_SESSION_TOKEN_LEN=100).
      "AQoXnyc4lcK4w4OIaHPGTq6EXAMPLEsessionTOKEN1234567890abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabc";

    it("row-1: env-var-only (AKIA + secret, no session token) — resolver returns correct shape without sessionToken", () => {
      process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIAIOSFODNN7EXAMPLE";
      process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] =
        "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY";
      // No session token set
      const creds = requireAssigneeCredentials("operator");
      expect(creds.accessKeyId).toBe("AKIAIOSFODNN7EXAMPLE");
      expect(creds.secretAccessKey).toBe(
        "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
      );
      expect(creds.sessionToken).toBeUndefined();
    });

    it("row-3: positive — ASIA key + session token — sessionToken propagated in credentials object", () => {
      process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = VALID_KEY;
      process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] = VALID_SECRET;
      process.env["ASSIGNEE_OPERATOR_SESSION_TOKEN"] = VALID_TOKEN;
      const creds = requireAssigneeCredentials("operator");
      expect(creds.accessKeyId).toBe(VALID_KEY);
      expect(creds.secretAccessKey).toBe(VALID_SECRET);
      expect(creds.sessionToken).toBe(VALID_TOKEN);
    });

    it("row-6: invalid (too-short) session token — throws InvalidSessionTokenError with SSO hint", () => {
      process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = VALID_KEY;
      process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] = VALID_SECRET;
      process.env["ASSIGNEE_OPERATOR_SESSION_TOKEN"] = "tooshort";
      expect(() => requireAssigneeCredentials("operator")).toThrow(
        InvalidSessionTokenError,
      );
    });

    it("row-6: invalid session token error message mentions aws sso login", () => {
      process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = VALID_KEY;
      process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] = VALID_SECRET;
      process.env["ASSIGNEE_OPERATOR_SESSION_TOKEN"] = "badtoken";
      try {
        requireAssigneeCredentials("operator");
        expect.fail("expected throw");
      } catch (err) {
        expect(err).toBeInstanceOf(InvalidSessionTokenError);
        expect((err as Error).message).toContain("aws sso login");
      }
    });

    it("tryAssigneeCredentials — propagates sessionToken when set", () => {
      process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = VALID_KEY;
      process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] = VALID_SECRET;
      process.env["ASSIGNEE_OPERATOR_SESSION_TOKEN"] = VALID_TOKEN;
      const creds = tryAssigneeCredentials("operator");
      expect(creds).not.toBeUndefined();
      expect(creds?.sessionToken).toBe(VALID_TOKEN);
    });

    it("tryAssigneeCredentials — ignores session token that is too short (silent drop)", () => {
      process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = VALID_KEY;
      process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] = VALID_SECRET;
      process.env["ASSIGNEE_OPERATOR_SESSION_TOKEN"] = "tinytoken";
      const creds = tryAssigneeCredentials("operator");
      expect(creds?.sessionToken).toBeUndefined();
    });

    it("row-5: no creds anywhere — throws MissingAssigneeCredentialsError with setup hint", () => {
      // All env vars already cleared by beforeEach scrubEnv
      expect(() => requireAssigneeCredentials("operator")).toThrow(
        MissingAssigneeCredentialsError,
      );
    });

    it("whitespace-only session token is treated as absent (no sessionToken in result)", () => {
      process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = VALID_KEY;
      process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] = VALID_SECRET;
      process.env["ASSIGNEE_OPERATOR_SESSION_TOKEN"] = "   ";
      const creds = requireAssigneeCredentials("operator");
      expect(creds.sessionToken).toBeUndefined();
    });
  });

  // ── M-α-30: reader/auditor sessionTokenKey parity ───────────────────────

  describe("requireAssigneeCredentials — reader/auditor session token (M-α-30)", () => {
    const VALID_KEY = "ASIAIOSFODNN7STSEXAMP";
    const VALID_SECRET = "stsSecretKeyValueExample123456789012345";
    const VALID_TOKEN =
      // Real STS session tokens are typically 100–1000+ chars (base64-encoded
      // blob). This fixture is ≥ 100 chars (SEC-031: MIN_SESSION_TOKEN_LEN=100).
      "AQoXnyc4lcK4w4OIaHPGTq6EXAMPLEsessionTOKEN1234567890abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabc";

    it("reader: propagates sessionToken when ASSIGNEE_READER_SESSION_TOKEN is set", () => {
      process.env["ASSIGNEE_READER_ACCESS_KEY_ID"] = VALID_KEY;
      process.env["ASSIGNEE_READER_SECRET_ACCESS_KEY"] = VALID_SECRET;
      process.env["ASSIGNEE_READER_SESSION_TOKEN"] = VALID_TOKEN;
      const creds = requireAssigneeCredentials("reader");
      expect(creds.sessionToken).toBe(VALID_TOKEN);
    });

    it("reader: no sessionToken when ASSIGNEE_READER_SESSION_TOKEN is absent", () => {
      process.env["ASSIGNEE_READER_ACCESS_KEY_ID"] = VALID_KEY;
      process.env["ASSIGNEE_READER_SECRET_ACCESS_KEY"] = VALID_SECRET;
      const creds = requireAssigneeCredentials("reader");
      expect(creds.sessionToken).toBeUndefined();
    });

    it("reader: throws InvalidSessionTokenError for too-short reader session token", () => {
      process.env["ASSIGNEE_READER_ACCESS_KEY_ID"] = VALID_KEY;
      process.env["ASSIGNEE_READER_SECRET_ACCESS_KEY"] = VALID_SECRET;
      process.env["ASSIGNEE_READER_SESSION_TOKEN"] = "tooshort";
      expect(() => requireAssigneeCredentials("reader")).toThrow(
        InvalidSessionTokenError,
      );
    });

    it("reader: tryAssigneeCredentials propagates reader sessionToken", () => {
      process.env["ASSIGNEE_READER_ACCESS_KEY_ID"] = VALID_KEY;
      process.env["ASSIGNEE_READER_SECRET_ACCESS_KEY"] = VALID_SECRET;
      process.env["ASSIGNEE_READER_SESSION_TOKEN"] = VALID_TOKEN;
      const creds = tryAssigneeCredentials("reader");
      expect(creds?.sessionToken).toBe(VALID_TOKEN);
    });

    it("auditor: propagates sessionToken when ASSIGNEE_AUDITOR_SESSION_TOKEN is set", () => {
      process.env["ASSIGNEE_AUDITOR_ACCESS_KEY_ID"] = VALID_KEY;
      process.env["ASSIGNEE_AUDITOR_SECRET_ACCESS_KEY"] = VALID_SECRET;
      process.env["ASSIGNEE_AUDITOR_SESSION_TOKEN"] = VALID_TOKEN;
      const creds = requireAssigneeCredentials("auditor");
      expect(creds.sessionToken).toBe(VALID_TOKEN);
    });

    it("auditor: no sessionToken when ASSIGNEE_AUDITOR_SESSION_TOKEN is absent", () => {
      process.env["ASSIGNEE_AUDITOR_ACCESS_KEY_ID"] = VALID_KEY;
      process.env["ASSIGNEE_AUDITOR_SECRET_ACCESS_KEY"] = VALID_SECRET;
      const creds = requireAssigneeCredentials("auditor");
      expect(creds.sessionToken).toBeUndefined();
    });

    it("auditor: throws InvalidSessionTokenError for too-short auditor session token", () => {
      process.env["ASSIGNEE_AUDITOR_ACCESS_KEY_ID"] = VALID_KEY;
      process.env["ASSIGNEE_AUDITOR_SECRET_ACCESS_KEY"] = VALID_SECRET;
      process.env["ASSIGNEE_AUDITOR_SESSION_TOKEN"] = "tooshort";
      expect(() => requireAssigneeCredentials("auditor")).toThrow(
        InvalidSessionTokenError,
      );
    });

    it("auditor: tryAssigneeCredentials propagates auditor sessionToken", () => {
      process.env["ASSIGNEE_AUDITOR_ACCESS_KEY_ID"] = VALID_KEY;
      process.env["ASSIGNEE_AUDITOR_SECRET_ACCESS_KEY"] = VALID_SECRET;
      process.env["ASSIGNEE_AUDITOR_SESSION_TOKEN"] = VALID_TOKEN;
      const creds = tryAssigneeCredentials("auditor");
      expect(creds?.sessionToken).toBe(VALID_TOKEN);
    });
  });

  // ── W2-03: Anti-pattern doc lint ─────────────────────────────────────────

  describe("sso-authentication.md anti-pattern lint (W2-02 / W2-03)", () => {
    it("docs/how-to/sso-authentication.md does NOT mention raw-key export as the SSO workaround", () => {
      // The doc must guide users towards --profile / AWS_PROFILE, NOT towards
      // exporting raw AWS keys as the SSO workaround. This test ensures the
      // anti-pattern never comes back.
      const docPath = join(
        // Navigate from packages/core/src/config/ up 4 levels to repo root, then into docs/
        new URL(".", import.meta.url).pathname,
        "../../../..",
        "docs/how-to/sso-authentication.md",
      );
      let content: string;
      try {
        content = readFileSync(docPath, "utf-8");
      } catch {
        throw new Error(
          `docs/how-to/sso-authentication.md not found at ${docPath}. ` +
            "The file must exist (W2-02 acceptance criterion).",
        );
      }

      // Must NOT instruct SSO users to export raw keys as the solution.
      // These patterns match only concrete anti-pattern instructions —
      // affirmative sentences recommending raw-key export as the SSO
      // workaround. They do NOT match negative guidance like "you do not
      // need to export raw access keys when using SSO".
      const antiPatterns = [
        /for SSO[,\s].*export AWS_ACCESS_KEY_ID/i,
        /to use SSO[,\s].*export your access keys/i,
        /you must export AWS_ACCESS_KEY_ID for SSO/i,
        /as a workaround[,\s].*export AWS_ACCESS_KEY_ID/i,
      ];
      for (const pattern of antiPatterns) {
        expect(
          pattern.test(content),
          `doc contains raw-key-export anti-pattern: ${pattern}`,
        ).toBe(false);
      }

      // MUST mention --profile and AWS_PROFILE as the supported approach.
      expect(content).toMatch(/--profile/);
      expect(content).toMatch(/AWS_PROFILE/);
    });
  });
});
