/**
 * Unit tests for AWS credential resolution helpers.
 *
 * Covers:
 *  - M-S6: stable error message (no cwd heuristic)
 *  - M-S7: whitespace-only env vars rejected
 *  - M-S8: availableRoles() / envVarsForRole() single source of truth
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  ASSIGNEE_ROLES,
  availableRoles,
  envVarsForRole,
  hasAssigneeCredentials,
  MissingAssigneeCredentialsError,
  requireAssigneeCredentials,
  tryAssigneeCredentials,
} from "./aws-credentials.js";

const ALL_VARS = [
  "ASSIGNEE_OPERATOR_ACCESS_KEY_ID",
  "ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY",
  "ASSIGNEE_READER_ACCESS_KEY_ID",
  "ASSIGNEE_READER_SECRET_ACCESS_KEY",
  "ASSIGNEE_AUDITOR_ACCESS_KEY_ID",
  "ASSIGNEE_AUDITOR_SECRET_ACCESS_KEY",
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
});
