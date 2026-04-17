import { describe, it, expect } from "vitest";
import { validateConfig, CONFIG_DEFAULTS } from "./config-schema.js";
import { ConfigurationError } from "../errors.js";

describe("validateConfig", () => {
  describe("valid full config", () => {
    it("returns typed object with all sections", () => {
      const raw = {
        defaults: {
          region: "us-west-2",
          tags: { environment: "dev", team: "platform" },
          naming: { prefix: "mycompany-" },
        },
        preferences: {
          auto_fix: "apply",
        },
      };

      const result = validateConfig(raw);
      expect(result.defaults?.region).toBe("us-west-2");
      expect(result.defaults?.tags).toEqual({
        environment: "dev",
        team: "platform",
      });
      expect(result.defaults?.naming?.prefix).toBe("mycompany-");
      expect(result.preferences?.auto_fix).toBe("apply");
    });
  });

  describe("missing optional sections return defaults", () => {
    it("empty object returns preference defaults", () => {
      const result = validateConfig({});
      expect(result.preferences?.auto_fix).toBe("ask");
      expect(result.defaults).toBeUndefined();
    });

    it("only defaults section still gets preference defaults", () => {
      const result = validateConfig({
        defaults: { region: "eu-west-1" },
      });
      expect(result.defaults?.region).toBe("eu-west-1");
      expect(result.preferences?.auto_fix).toBe("ask");
    });

    it("only preferences section has no defaults section", () => {
      const result = validateConfig({
        preferences: { auto_fix: "skip" },
      });
      expect(result.defaults).toBeUndefined();
      expect(result.preferences?.auto_fix).toBe("skip");
    });
  });

  describe("invalid enum values throw ConfigurationError", () => {
    it("invalid auto_fix", () => {
      expect(() =>
        validateConfig({ preferences: { auto_fix: "fast" } }),
      ).toThrow(ConfigurationError);
      try {
        validateConfig({ preferences: { auto_fix: "fast" } });
      } catch (err) {
        expect((err as Error).message).toContain("preferences.auto_fix");
        expect((err as Error).message).toContain("ask | apply | skip");
      }
    });
  });

  describe("extra/unknown keys are silently ignored", () => {
    it("extra top-level keys are ignored", () => {
      const result = validateConfig({
        defaults: { region: "us-east-1" },
        future_key: "ignored",
        optimization: { enabled: true },
      });
      expect(result.defaults?.region).toBe("us-east-1");
    });

    it("extra keys in preferences are ignored", () => {
      const result = validateConfig({
        preferences: { auto_fix: "ask", custom_pref: true },
      });
      expect(result.preferences?.auto_fix).toBe("ask");
    });
  });

  describe("empty/undefined input returns all defaults", () => {
    it("undefined returns defaults", () => {
      const result = validateConfig(undefined);
      expect(result.preferences).toEqual(CONFIG_DEFAULTS);
    });

    it("null returns defaults", () => {
      const result = validateConfig(null);
      expect(result.preferences).toEqual(CONFIG_DEFAULTS);
    });
  });

  describe("invalid types throw ConfigurationError", () => {
    it("array throws", () => {
      expect(() => validateConfig([1, 2, 3])).toThrow(ConfigurationError);
    });

    it("string throws", () => {
      expect(() => validateConfig("not an object")).toThrow(ConfigurationError);
    });

    it("defaults as non-object throws", () => {
      expect(() => validateConfig({ defaults: "bad" })).toThrow(
        ConfigurationError,
      );
    });

    it("preferences as non-object throws", () => {
      expect(() => validateConfig({ preferences: 42 })).toThrow(
        ConfigurationError,
      );
    });
  });

  describe("org_policy passthrough", () => {
    it("passes through org_policy without deep validation", () => {
      // Tier C: strengthened — assert the actual passed-through shape,
      // not just defined-ness
      const result = validateConfig({
        org_policy: {
          "AWS::S3::Bucket": {
            Encryption: { policy: "locked", value: "AES256" },
          },
        },
      });
      expect(result.org_policy?.["AWS::S3::Bucket"]).toMatchObject({
        Encryption: { policy: "locked", value: "AES256" },
      });
    });
  });

  describe("CONFIG_DEFAULTS", () => {
    it("has correct default values", () => {
      expect(CONFIG_DEFAULTS.auto_fix).toBe("ask");
    });
  });
});
