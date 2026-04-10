import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from "vitest";
import { loadEnvOverrides, parseTags } from "./env-overrides.js";

describe("env-overrides", () => {
  let stderrSpy: MockInstance;

  beforeEach(() => {
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    vi.restoreAllMocks();
  });

  describe("loadEnvOverrides", () => {
    it("returns empty object when no env vars are set", () => {
      const result = loadEnvOverrides({});
      expect(result).toEqual({});
    });

    it("ASSIGNEE_DEFAULT_REGION sets defaults.region", () => {
      const result = loadEnvOverrides({
        ASSIGNEE_DEFAULT_REGION: "us-west-2",
      });
      expect(result.defaults?.region).toBe("us-west-2");
    });

    it("ASSIGNEE_AUTO_FIX=apply sets preferences.auto_fix", () => {
      const result = loadEnvOverrides({
        ASSIGNEE_AUTO_FIX: "apply",
      });
      expect(result.preferences?.auto_fix).toBe("apply");
    });

    it("ASSIGNEE_AUTO_FIX=skip sets preferences.auto_fix", () => {
      const result = loadEnvOverrides({
        ASSIGNEE_AUTO_FIX: "skip",
      });
      expect(result.preferences?.auto_fix).toBe("skip");
    });

    it("ASSIGNEE_AUTO_FIX=fast logs warning and field is undefined", () => {
      const result = loadEnvOverrides({
        ASSIGNEE_AUTO_FIX: "fast",
      });
      expect(result.preferences?.auto_fix).toBeUndefined();
    });

    it("ASSIGNEE_OUTPUT_FORMAT=json sets preferences.output_format", () => {
      const result = loadEnvOverrides({
        ASSIGNEE_OUTPUT_FORMAT: "json",
      });
      expect(result.preferences?.output_format).toBe("json");
    });

    it("ASSIGNEE_OUTPUT_FORMAT=csv logs warning and field is undefined", () => {
      const result = loadEnvOverrides({
        ASSIGNEE_OUTPUT_FORMAT: "csv",
      });
      expect(result.preferences?.output_format).toBeUndefined();
    });

    it("ASSIGNEE_VERBOSITY=quiet sets preferences.verbosity", () => {
      const result = loadEnvOverrides({
        ASSIGNEE_VERBOSITY: "quiet",
      });
      expect(result.preferences?.verbosity).toBe("quiet");
    });

    it("ASSIGNEE_VERBOSITY=loud logs warning and field is undefined", () => {
      const result = loadEnvOverrides({
        ASSIGNEE_VERBOSITY: "loud",
      });
      expect(result.preferences?.verbosity).toBeUndefined();
    });

    it("ASSIGNEE_DEFAULT_TAGS parses comma-separated key=value pairs", () => {
      const result = loadEnvOverrides({
        ASSIGNEE_DEFAULT_TAGS: "env=prod,team=platform",
      });
      expect(result.defaults?.tags).toEqual({
        env: "prod",
        team: "platform",
      });
    });

    it("multiple env vars are combined into a single config", () => {
      const result = loadEnvOverrides({
        ASSIGNEE_DEFAULT_REGION: "eu-west-1",
        ASSIGNEE_AUTO_FIX: "apply",
        ASSIGNEE_VERBOSITY: "verbose",
        ASSIGNEE_DEFAULT_TAGS: "env=ci",
      });
      expect(result.defaults?.region).toBe("eu-west-1");
      expect(result.defaults?.tags).toEqual({ env: "ci" });
      expect(result.preferences?.auto_fix).toBe("apply");
      expect(result.preferences?.verbosity).toBe("verbose");
    });

    it("does not consume ASSIGNEE_CONFIG_DIR", () => {
      const result = loadEnvOverrides({
        ASSIGNEE_CONFIG_DIR: "/custom/path",
      });
      expect(result).toEqual({});
    });

    it("ignores empty string values", () => {
      const result = loadEnvOverrides({
        ASSIGNEE_DEFAULT_REGION: "",
        ASSIGNEE_AUTO_FIX: "",
      });
      expect(result).toEqual({});
    });
  });

  describe("parseTags", () => {
    it("parses basic key=value pairs", () => {
      expect(parseTags("env=prod,team=platform")).toEqual({
        env: "prod",
        team: "platform",
      });
    });

    it("trims whitespace around keys and values", () => {
      expect(parseTags(" env = prod , team = platform ")).toEqual({
        env: "prod",
        team: "platform",
      });
    });

    it("skips entries without equals sign and logs warning", () => {
      const result = parseTags("env=prod,broken,team=platform");
      expect(result).toEqual({ env: "prod", team: "platform" });
    });

    it("allows empty value (flag=)", () => {
      expect(parseTags("flag=")).toEqual({ flag: "" });
    });

    it("handles value containing equals sign", () => {
      expect(parseTags("key=a=b")).toEqual({ key: "a=b" });
    });

    it("skips entries with empty key", () => {
      const result = parseTags("=value,env=prod");
      expect(result).toEqual({ env: "prod" });
    });

    it("returns empty object for empty string", () => {
      expect(parseTags("")).toEqual({});
    });

    it("handles single entry", () => {
      expect(parseTags("env=prod")).toEqual({ env: "prod" });
    });
  });

  // ── Story 44.1: ASSIGNEE_LLM_* env var parsing ───────────────────────
  describe("ASSIGNEE_LLM_* env overrides (Story 44.1)", () => {
    it("parses ASSIGNEE_LLM_DEFAULT into llm.default", () => {
      const result = loadEnvOverrides({
        ASSIGNEE_LLM_DEFAULT: "bedrock/amazon.nova-lite-v1:0",
      });
      expect(result.llm?.["default"]).toBe("bedrock/amazon.nova-lite-v1:0");
    });

    it("parses ASSIGNEE_LLM_PLAN_GENERATOR into llm.plan_generator", () => {
      const result = loadEnvOverrides({
        ASSIGNEE_LLM_PLAN_GENERATOR: "anthropic/claude-sonnet-4-5",
      });
      expect(result.llm?.["plan_generator"]).toBe(
        "anthropic/claude-sonnet-4-5",
      );
    });

    it("lowercases the callsite key from env var name", () => {
      const result = loadEnvOverrides({
        ASSIGNEE_LLM_INTENT_PARSER: "bedrock/us.amazon.nova-micro-v1:0",
      });
      expect(result.llm?.["intent_parser"]).toBe(
        "bedrock/us.amazon.nova-micro-v1:0",
      );
    });

    it("parses multiple ASSIGNEE_LLM_* vars", () => {
      const result = loadEnvOverrides({
        ASSIGNEE_LLM_DEFAULT: "bedrock/amazon.nova-lite-v1:0",
        ASSIGNEE_LLM_PLAN_GENERATOR: "anthropic/claude-sonnet-4-5",
        ASSIGNEE_LLM_ADVICE_GENERATOR: "bedrock/us.amazon.nova-micro-v1:0",
      });
      expect(result.llm).toEqual({
        default: "bedrock/amazon.nova-lite-v1:0",
        plan_generator: "anthropic/claude-sonnet-4-5",
        advice_generator: "bedrock/us.amazon.nova-micro-v1:0",
      });
    });

    it("ignores ASSIGNEE_LLM_* with invalid format (no slash)", () => {
      const result = loadEnvOverrides({
        ASSIGNEE_LLM_DEFAULT: "just-a-model",
      });
      expect(result.llm).toBeUndefined();
    });

    it("ignores ASSIGNEE_LLM_* with empty provider", () => {
      const result = loadEnvOverrides({
        ASSIGNEE_LLM_DEFAULT: "/model-id",
      });
      expect(result.llm).toBeUndefined();
    });

    it("ignores ASSIGNEE_LLM_* with empty model-id", () => {
      const result = loadEnvOverrides({
        ASSIGNEE_LLM_DEFAULT: "anthropic/",
      });
      expect(result.llm).toBeUndefined();
    });

    it("ignores empty ASSIGNEE_LLM_* values", () => {
      const result = loadEnvOverrides({
        ASSIGNEE_LLM_DEFAULT: "",
      });
      expect(result.llm).toBeUndefined();
    });

    it("ignores undefined ASSIGNEE_LLM_* values", () => {
      const result = loadEnvOverrides({
        ASSIGNEE_LLM_DEFAULT: undefined,
      });
      expect(result.llm).toBeUndefined();
    });

    it("mixes LLM overrides with other config overrides", () => {
      const result = loadEnvOverrides({
        ASSIGNEE_AUTO_FIX: "apply",
        ASSIGNEE_LLM_PLAN_GENERATOR: "anthropic/claude-sonnet-4-5",
      });
      expect(result.preferences?.auto_fix).toBe("apply");
      expect(result.llm?.["plan_generator"]).toBe(
        "anthropic/claude-sonnet-4-5",
      );
    });
  });
});
