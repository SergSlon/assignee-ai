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
});
