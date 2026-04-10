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
          output_format: "json",
          verbosity: "verbose",
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
      expect(result.preferences?.output_format).toBe("json");
      expect(result.preferences?.verbosity).toBe("verbose");
    });
  });

  describe("missing optional sections return defaults", () => {
    it("empty object returns preference defaults", () => {
      const result = validateConfig({});
      expect(result.preferences?.auto_fix).toBe("ask");
      expect(result.preferences?.output_format).toBe("table");
      expect(result.preferences?.verbosity).toBe("normal");
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
      expect(result.preferences?.output_format).toBe("table");
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

    it("invalid output_format", () => {
      expect(() =>
        validateConfig({ preferences: { output_format: "xml" } }),
      ).toThrow(ConfigurationError);
    });

    it("invalid verbosity", () => {
      expect(() =>
        validateConfig({ preferences: { verbosity: "debug" } }),
      ).toThrow(ConfigurationError);
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

  // ── Story 44.1: llm section validation ──────────────────────────────
  describe("llm section (Story 44.1)", () => {
    it("accepts valid llm config with provider/model format", () => {
      const result = validateConfig({
        llm: {
          default: "bedrock/amazon.nova-lite-v1:0",
          plan_generator: "anthropic/claude-sonnet-4-5",
          intent_parser: "bedrock/us.amazon.nova-micro-v1:0",
        },
      });
      expect(result.llm).toEqual({
        default: "bedrock/amazon.nova-lite-v1:0",
        plan_generator: "anthropic/claude-sonnet-4-5",
        intent_parser: "bedrock/us.amazon.nova-micro-v1:0",
      });
    });

    it("rejects llm that is not an object", () => {
      expect(() => validateConfig({ llm: "not-an-object" })).toThrow(
        "llm: must be an object",
      );
    });

    it("rejects llm values that are not strings", () => {
      expect(() => validateConfig({ llm: { default: 42 } })).toThrow(
        'llm.default: must be a string in "provider/model-id" format',
      );
    });

    it("rejects model strings without slash", () => {
      expect(() =>
        validateConfig({ llm: { default: "just-a-model" } }),
      ).toThrow('llm.default: invalid model format "just-a-model"');
    });

    it("rejects model strings with empty provider", () => {
      expect(() => validateConfig({ llm: { default: "/model-id" } })).toThrow(
        'llm.default: invalid model format "/model-id"',
      );
    });

    it("rejects model strings with empty model-id", () => {
      expect(() => validateConfig({ llm: { default: "anthropic/" } })).toThrow(
        'llm.default: invalid model format "anthropic/"',
      );
    });

    it("skips null/undefined llm values silently", () => {
      const result = validateConfig({
        llm: {
          default: "bedrock/amazon.nova-lite-v1:0",
          plan_generator: null,
          intent_parser: undefined,
        },
      });
      expect(result.llm).toEqual({
        default: "bedrock/amazon.nova-lite-v1:0",
      });
    });

    it("omits llm from result when all values are null/undefined", () => {
      const result = validateConfig({
        llm: { plan_generator: null },
      });
      expect(result.llm).toBeUndefined();
    });

    it("accepts bedrock model with colons in model-id", () => {
      const result = validateConfig({
        llm: { default: "bedrock/amazon.nova-lite-v1:0" },
      });
      expect(result.llm?.["default"]).toBe("bedrock/amazon.nova-lite-v1:0");
    });
  });

  describe("CONFIG_DEFAULTS", () => {
    it("has correct default values", () => {
      expect(CONFIG_DEFAULTS.auto_fix).toBe("ask");
      expect(CONFIG_DEFAULTS.output_format).toBe("table");
      expect(CONFIG_DEFAULTS.verbosity).toBe("normal");
    });
  });
});
