import { describe, it, expect } from "vitest";
import { resolveGlobalConfig } from "./resolve-global-config.js";
import { CONFIG_DEFAULTS, AutoFixMode } from "./config-schema.js";

describe("resolveGlobalConfig", () => {
  describe("empty input", () => {
    it("returns fully-populated preferences from CONFIG_DEFAULTS when no sources are provided", () => {
      const result = resolveGlobalConfig({});
      expect(result.preferences).toEqual(CONFIG_DEFAULTS);
    });

    it("omits defaults, budget, and org_policy when no source provides them", () => {
      const result = resolveGlobalConfig({});
      expect(result.defaults).toBeUndefined();
      expect(result.budget).toBeUndefined();
      expect(result.org_policy).toBeUndefined();
    });
  });

  describe("precedence — highest wins", () => {
    it("CLI flag > env > project > user > CONFIG_DEFAULTS for auto_fix", () => {
      const result = resolveGlobalConfig({
        cliFlags: { preferences: { auto_fix: AutoFixMode.SKIP } },
        envOverrides: { preferences: { auto_fix: AutoFixMode.APPLY } },
        projectConfig: { preferences: { auto_fix: AutoFixMode.ASK } },
        userConfig: { preferences: { auto_fix: AutoFixMode.APPLY } },
      });
      expect(result.preferences.auto_fix).toBe(AutoFixMode.SKIP);
    });

    it("env > project > user > CONFIG_DEFAULTS for auto_fix (no CLI)", () => {
      const result = resolveGlobalConfig({
        envOverrides: { preferences: { auto_fix: AutoFixMode.APPLY } },
        projectConfig: { preferences: { auto_fix: AutoFixMode.ASK } },
        userConfig: { preferences: { auto_fix: AutoFixMode.ASK } },
      });
      expect(result.preferences.auto_fix).toBe(AutoFixMode.APPLY);
    });

    it("project > user > CONFIG_DEFAULTS for verbosity", () => {
      const result = resolveGlobalConfig({
        projectConfig: { preferences: { verbosity: "verbose" } },
        userConfig: { preferences: { verbosity: "quiet" } },
      });
      expect(result.preferences.verbosity).toBe("verbose");
    });

    it("user > CONFIG_DEFAULTS when only user is provided", () => {
      const result = resolveGlobalConfig({
        userConfig: { preferences: { output_format: "json" } },
      });
      expect(result.preferences.output_format).toBe("json");
      // Unspecified keys still come from CONFIG_DEFAULTS.
      expect(result.preferences.auto_fix).toBe(CONFIG_DEFAULTS.auto_fix);
      expect(result.preferences.verbosity).toBe(CONFIG_DEFAULTS.verbosity);
    });

    it("different keys from different levels coexist (no source wipes another)", () => {
      const result = resolveGlobalConfig({
        envOverrides: { preferences: { auto_fix: AutoFixMode.APPLY } },
        userConfig: { preferences: { verbosity: "verbose" } },
      });
      expect(result.preferences.auto_fix).toBe(AutoFixMode.APPLY);
      expect(result.preferences.verbosity).toBe("verbose");
      // output_format is not in either source — falls back to default.
      expect(result.preferences.output_format).toBe(
        CONFIG_DEFAULTS.output_format,
      );
    });
  });

  describe("defaults.region precedence", () => {
    it("env > project > user for region", () => {
      const result = resolveGlobalConfig({
        envOverrides: { defaults: { region: "eu-west-1" } },
        projectConfig: { defaults: { region: "us-west-2" } },
        userConfig: { defaults: { region: "us-east-1" } },
      });
      expect(result.defaults?.region).toBe("eu-west-1");
    });
  });

  describe("defaults.tags nested merge", () => {
    it("merges tag keys across all levels instead of overwriting the whole map", () => {
      const result = resolveGlobalConfig({
        userConfig: { defaults: { tags: { owner: "alice", cost: "eng" } } },
        projectConfig: { defaults: { tags: { project: "assignee" } } },
        envOverrides: { defaults: { tags: { env: "prod" } } },
      });
      // All four tags should be present (no wipe-out).
      expect(result.defaults?.tags).toEqual({
        owner: "alice",
        cost: "eng",
        project: "assignee",
        env: "prod",
      });
    });

    it("higher-priority value overrides the same key from a lower level", () => {
      const result = resolveGlobalConfig({
        envOverrides: { defaults: { tags: { env: "staging" } } },
        userConfig: { defaults: { tags: { env: "production" } } },
      });
      expect(result.defaults?.tags).toEqual({ env: "staging" });
    });
  });

  describe("defaults.naming nested merge", () => {
    it("prefix from user and suffix from project both survive", () => {
      const result = resolveGlobalConfig({
        userConfig: { defaults: { naming: { prefix: "mycorp-" } } },
        projectConfig: { defaults: { naming: { suffix: "-prod" } } },
      });
      expect(result.defaults?.naming).toEqual({
        prefix: "mycorp-",
        suffix: "-prod",
      });
    });
  });

  describe("budget merging", () => {
    it("higher-priority source overrides budget fields", () => {
      const result = resolveGlobalConfig({
        envOverrides: { budget: { monthly_limit_usd: 500 } },
        userConfig: { budget: { monthly_limit_usd: 100, warn_only: true } },
      });
      expect(result.budget?.monthly_limit_usd).toBe(500);
      // warn_only wasn't in env → user value survives.
      expect(result.budget?.warn_only).toBe(true);
    });

    it("is undefined when no source defines a budget", () => {
      const result = resolveGlobalConfig({
        userConfig: { preferences: { auto_fix: AutoFixMode.APPLY } },
      });
      expect(result.budget).toBeUndefined();
    });
  });

  describe("org_policy precedence", () => {
    it("uses the highest-priority source that defines org_policy (no shallow merge)", () => {
      const userPolicy = { "AWS::S3::Bucket": { locked: "userOnly" } };
      const projectPolicy = { "AWS::S3::Bucket": { locked: "projectOnly" } };
      const result = resolveGlobalConfig({
        projectConfig: { org_policy: projectPolicy },
        userConfig: { org_policy: userPolicy },
      });
      // Project wins; user's org_policy is NOT shallow-merged into it.
      expect(result.org_policy).toEqual(projectPolicy);
    });

    it("is undefined when no source defines org_policy", () => {
      expect(resolveGlobalConfig({}).org_policy).toBeUndefined();
    });
  });

  describe("regression: dead env-overrides loader wiring", () => {
    it("env var for ASSIGNEE_AUTO_FIX actually reaches the resolved preferences", () => {
      // A2 (2026-04-08): before this helper existed, loadEnvOverrides()
      // was dead code — its output was never merged with user/project
      // config, so a CI caller setting ASSIGNEE_AUTO_FIX=apply saw no
      // effect unless they also had a user config file. This test
      // locks in the fix: even with no user or project config, the
      // env override takes effect.
      const envOverrides = { preferences: { auto_fix: AutoFixMode.APPLY } };
      const result = resolveGlobalConfig({ envOverrides });
      expect(result.preferences.auto_fix).toBe(AutoFixMode.APPLY);
    });
  });
});
