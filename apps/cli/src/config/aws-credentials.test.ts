import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  requireAssigneeCredentials,
  tryAssigneeCredentials,
  hasAssigneeCredentials,
  MissingAssigneeCredentialsError,
} from "./aws-credentials.js";

describe("aws-credentials", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    // Clear all assignee credential env vars before each test
    delete process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"];
    delete process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"];
    delete process.env["ASSIGNEE_READER_ACCESS_KEY_ID"];
    delete process.env["ASSIGNEE_READER_SECRET_ACCESS_KEY"];
    delete process.env["ASSIGNEE_AUDITOR_ACCESS_KEY_ID"];
    delete process.env["ASSIGNEE_AUDITOR_SECRET_ACCESS_KEY"];
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  describe("requireAssigneeCredentials", () => {
    it("returns operator credentials when both env vars are set", () => {
      process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIA123";
      process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] = "secret456";

      const creds = requireAssigneeCredentials("operator");
      expect(creds).toEqual({
        accessKeyId: "AKIA123",
        secretAccessKey: "secret456",
      });
    });

    it("throws MissingAssigneeCredentialsError when operator key is missing", () => {
      process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] = "secret456";

      expect(() => requireAssigneeCredentials("operator")).toThrow(
        MissingAssigneeCredentialsError,
      );
    });

    it("throws MissingAssigneeCredentialsError when operator secret is missing", () => {
      process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIA123";

      expect(() => requireAssigneeCredentials("operator")).toThrow(
        /Missing operator credentials/,
      );
    });

    it("error message includes the exact env var names", () => {
      try {
        requireAssigneeCredentials("reader");
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(MissingAssigneeCredentialsError);
        const msg = (err as Error).message;
        expect(msg).toContain("ASSIGNEE_READER_ACCESS_KEY_ID");
        expect(msg).toContain("ASSIGNEE_READER_SECRET_ACCESS_KEY");
      }
    });

    it("works for all three roles (operator, reader, auditor)", () => {
      const roles = ["operator", "reader", "auditor"] as const;
      for (const role of roles) {
        const prefix = `ASSIGNEE_${role.toUpperCase()}`;
        process.env[`${prefix}_ACCESS_KEY_ID`] = `AKIA-${role}`;
        process.env[`${prefix}_SECRET_ACCESS_KEY`] = `secret-${role}`;

        const creds = requireAssigneeCredentials(role);
        expect(creds.accessKeyId).toBe(`AKIA-${role}`);
        expect(creds.secretAccessKey).toBe(`secret-${role}`);
      }
    });

    it("does NOT fall back to AWS_ACCESS_KEY_ID from shell", () => {
      // Belt-and-suspenders: even if shell vars are set, require should throw
      process.env["AWS_ACCESS_KEY_ID"] = "shell-key";
      process.env["AWS_SECRET_ACCESS_KEY"] = "shell-secret";

      expect(() => requireAssigneeCredentials("operator")).toThrow(
        MissingAssigneeCredentialsError,
      );
    });

    it("empty string credentials are treated as missing", () => {
      process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "";
      process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] = "";

      expect(() => requireAssigneeCredentials("operator")).toThrow(
        MissingAssigneeCredentialsError,
      );
    });
  });

  describe("tryAssigneeCredentials", () => {
    it("returns credentials when set", () => {
      process.env["ASSIGNEE_READER_ACCESS_KEY_ID"] = "AKIA-reader";
      process.env["ASSIGNEE_READER_SECRET_ACCESS_KEY"] = "secret-reader";

      expect(tryAssigneeCredentials("reader")).toEqual({
        accessKeyId: "AKIA-reader",
        secretAccessKey: "secret-reader",
      });
    });

    it("returns undefined when credentials are missing (never throws)", () => {
      expect(tryAssigneeCredentials("operator")).toBeUndefined();
      expect(tryAssigneeCredentials("reader")).toBeUndefined();
      expect(tryAssigneeCredentials("auditor")).toBeUndefined();
    });

    it("returns undefined when only one half is set", () => {
      process.env["ASSIGNEE_AUDITOR_ACCESS_KEY_ID"] = "AKIA-auditor";
      expect(tryAssigneeCredentials("auditor")).toBeUndefined();
    });
  });

  describe("hasAssigneeCredentials", () => {
    it("returns true when credentials are fully set", () => {
      process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIA123";
      process.env["ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY"] = "secret456";
      expect(hasAssigneeCredentials("operator")).toBe(true);
    });

    it("returns false when either half is missing", () => {
      expect(hasAssigneeCredentials("operator")).toBe(false);

      process.env["ASSIGNEE_OPERATOR_ACCESS_KEY_ID"] = "AKIA123";
      expect(hasAssigneeCredentials("operator")).toBe(false);
    });
  });
});
