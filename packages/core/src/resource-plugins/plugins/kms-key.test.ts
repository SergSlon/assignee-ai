import { describe, it, expect } from "vitest";
import { kmsKeyPlugin } from "./kms-key.js";
import { RESOURCE_TYPES } from "../../config/resource-types.js";

describe("kmsKeyPlugin", () => {
  it("has the correct resourceType", () => {
    expect(kmsKeyPlugin.resourceType).toBe(RESOURCE_TYPES.KMS_KEY);
  });

  it("all commonField question types are valid", () => {
    const validTypes = new Set(["boolean", "enum", "string", "multi"]);
    for (const field of kmsKeyPlugin.commonFields) {
      expect(validTypes.has(field.question.type)).toBe(true);
    }
  });

  it("declares secure-by-default defaults", () => {
    // BP-relevant defaults must line up with the secure-by-default
    // expectations the rest of the codebase relies on for CMK targets:
    //   - Symmetric AES-256 (covers EFS/S3/RDS/etc encryption)
    //   - ENCRYPT_DECRYPT usage (not SIGN_VERIFY / HMAC)
    //   - Automatic key rotation enabled
    //   - Key enabled at creation
    //   - Not multi-region (avoids per-region double-charging unless
    //     explicitly asked)
    expect(kmsKeyPlugin.defaults["KeySpec"]).toBe("SYMMETRIC_DEFAULT");
    expect(kmsKeyPlugin.defaults["KeyUsage"]).toBe("ENCRYPT_DECRYPT");
    expect(kmsKeyPlugin.defaults["EnableKeyRotation"]).toBe(true);
    expect(kmsKeyPlugin.defaults["Enabled"]).toBe(true);
    expect(kmsKeyPlugin.defaults["MultiRegion"]).toBe(false);
  });

  describe("Description validation", () => {
    const field = kmsKeyPlugin.commonFields.find(
      (f) => f.name === "Description",
    )!;

    it("accepts empty (optional)", () => {
      expect(field.question.validate?.("")).toBeUndefined();
    });

    it("accepts a short human description", () => {
      expect(
        field.question.validate?.("Encrypts prod database backups"),
      ).toBeUndefined();
    });

    it("rejects descriptions over 8192 characters", () => {
      expect(field.question.validate?.("a".repeat(8193))).toMatch(
        /8192 characters/,
      );
    });
  });

  describe("KeyUsage enum", () => {
    const field = kmsKeyPlugin.commonFields.find((f) => f.name === "KeyUsage")!;

    it("covers every documented usage mode", () => {
      expect(field.question.type).toBe("enum");
      const options =
        field.question.type === "enum" && field.question.options
          ? field.question.options.map((o) => o.value)
          : [];
      // AWS KMS supports ENCRYPT_DECRYPT, SIGN_VERIFY,
      // GENERATE_VERIFY_MAC, and KEY_AGREEMENT as of 2026.
      expect(options).toEqual(
        expect.arrayContaining([
          "ENCRYPT_DECRYPT",
          "SIGN_VERIFY",
          "GENERATE_VERIFY_MAC",
          "KEY_AGREEMENT",
        ]),
      );
    });
  });

  describe("KeySpec enum", () => {
    const field = kmsKeyPlugin.commonFields.find((f) => f.name === "KeySpec")!;

    it("includes symmetric + common asymmetric + HMAC specs", () => {
      expect(field.question.type).toBe("enum");
      const options =
        field.question.type === "enum" && field.question.options
          ? field.question.options.map((o) => o.value)
          : [];
      // Symmetric + asymmetric + HMAC families must all be present.
      expect(options).toContain("SYMMETRIC_DEFAULT");
      expect(options).toContain("RSA_2048");
      expect(options).toContain("RSA_4096");
      expect(options).toContain("ECC_NIST_P256");
      expect(options).toContain("ECC_SECG_P256K1");
      expect(options).toContain("HMAC_256");
    });
  });

  describe("PendingWindowInDays (advanced) validation", () => {
    const field = kmsKeyPlugin.advancedFields.find(
      (f) => f.name === "PendingWindowInDays",
    )!;

    it("accepts empty (defaults to 30)", () => {
      expect(field.question.validate?.("")).toBeUndefined();
    });

    it("accepts 7 (minimum)", () => {
      expect(field.question.validate?.("7")).toBeUndefined();
    });

    it("accepts 30 (maximum)", () => {
      expect(field.question.validate?.("30")).toBeUndefined();
    });

    it("rejects 6 (below minimum)", () => {
      expect(field.question.validate?.("6")).toMatch(/between 7 and 30/);
    });

    it("rejects 31 (above maximum)", () => {
      expect(field.question.validate?.("31")).toMatch(/between 7 and 30/);
    });

    it("rejects non-integers", () => {
      expect(field.question.validate?.("15.5")).toMatch(/integer/);
      expect(field.question.validate?.("fifteen")).toMatch(/integer/);
    });

    it("toCfn converts a valid integer string to a number", () => {
      expect(field.toCfn?.("30")).toBe(30);
      expect(field.toCfn?.("7")).toBe(7);
    });

    it("toCfn returns undefined for empty input", () => {
      expect(field.toCfn?.("")).toBeUndefined();
    });
  });

  describe("KeyPolicy (advanced) validation", () => {
    const field = kmsKeyPlugin.advancedFields.find(
      (f) => f.name === "KeyPolicy",
    )!;

    it("accepts empty (KMS attaches a default root-account policy)", () => {
      expect(field.question.validate?.("")).toBeUndefined();
    });

    it("accepts valid JSON object", () => {
      expect(
        field.question.validate?.('{"Version":"2012-10-17","Statement":[]}'),
      ).toBeUndefined();
    });

    it("rejects invalid JSON", () => {
      expect(field.question.validate?.("{not json")).toBe(
        "Key policy must be valid JSON",
      );
    });

    it("rejects JSON that isn't an object", () => {
      expect(field.question.validate?.('"a string"')).toBe(
        "Key policy must be a JSON object",
      );
    });

    it("toCfn parses valid JSON into an object", () => {
      const parsed = field.toCfn?.('{"Version":"2012-10-17","Statement":[]}');
      expect(parsed).toEqual({ Version: "2012-10-17", Statement: [] });
    });
  });

  describe("configHints", () => {
    it("recommends symmetric + rotation as the secure default", () => {
      const hints = kmsKeyPlugin.configHints!.join(" ");
      expect(hints).toMatch(/SYMMETRIC/);
      expect(hints).toMatch(/rotation|EnableKeyRotation/i);
    });

    it("warns about asymmetric incompatibility with at-rest integrations", () => {
      const hints = kmsKeyPlugin.configHints!.join(" ");
      expect(hints).toMatch(/asymmetric/i);
      expect(hints).toMatch(/EFS|S3|RDS|service integration/i);
    });

    it("documents per-key monthly billing + prorating WITHOUT hardcoded prices", () => {
      const hints = kmsKeyPlugin.configHints!.join(" ");
      // Price guidance MUST describe the billing shape but route users to
      // the Pricing MCP (`assignee cost`) for live rates — see
      // `feedback_no_hardcoded_prices`.
      expect(hints).toMatch(/per-key monthly|per key per month/i);
      expect(hints).toMatch(/prorat/i);
      expect(hints).toMatch(/assignee cost|Pricing.MCP/i);
      // Hard invariant: no hardcoded dollar amounts anywhere in configHints.
      expect(hints).not.toMatch(/\$\d/);
    });

    it("flags the multi-region per-region billing multiplier", () => {
      const hints = kmsKeyPlugin.configHints!.join(" ");
      expect(hints).toMatch(/multi-region/i);
      expect(hints).toMatch(/per region|each region/i);
    });
  });
});
