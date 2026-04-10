import { describe, it, expect, vi, beforeEach } from "vitest";
import { AutoFixMode } from "@assignee/core";

// A2 + A5 (2026-04-08): load-global-config composes three sources —
// env vars, project yaml, and the legacy UserConfig. Mock each of
// the underlying loaders at the module boundary so the test controls
// exactly what each level returns, then verify the precedence order
// through the real `resolveGlobalConfig()` path.

const { mockLoadEnvOverrides, mockLoadProjectConfig } = vi.hoisted(() => ({
  mockLoadEnvOverrides: vi.fn(),
  mockLoadProjectConfig: vi.fn(),
}));

vi.mock("./env-overrides.js", () => ({
  loadEnvOverrides: mockLoadEnvOverrides,
}));
vi.mock("./project-config-loader.js", () => ({
  loadProjectConfig: mockLoadProjectConfig,
}));

import {
  loadGlobalConfig,
  adaptUserConfigToAssignee,
} from "./load-global-config.js";

beforeEach(() => {
  mockLoadEnvOverrides.mockReset();
  mockLoadProjectConfig.mockReset();
  // Default: no env, no project yaml — the tests opt in when they
  // need a specific source.
  mockLoadEnvOverrides.mockReturnValue({});
  mockLoadProjectConfig.mockResolvedValue(undefined);
});

describe("adaptUserConfigToAssignee (A2)", () => {
  it("returns undefined when userConfig is undefined", () => {
    expect(adaptUserConfigToAssignee(undefined)).toBeUndefined();
  });

  it("returns undefined when userConfig has no preferences or bestPractices.autoFix", () => {
    expect(
      adaptUserConfigToAssignee({
        "AWS::S3::Bucket": { BucketName: "foo" },
      } as unknown as Parameters<typeof adaptUserConfigToAssignee>[0]),
    ).toBeUndefined();
  });

  it("passes through an explicit AssigneeConfig-shaped user yaml verbatim", () => {
    // Some users already maintain a new-shape YAML with preferences:
    // at the top level. The adapter must not wipe that out.
    const uc = {
      preferences: { auto_fix: AutoFixMode.APPLY, verbosity: "verbose" },
      defaults: { region: "eu-west-1" },
    } as unknown as Parameters<typeof adaptUserConfigToAssignee>[0];
    const result = adaptUserConfigToAssignee(uc);
    expect(result?.preferences?.auto_fix).toBe(AutoFixMode.APPLY);
    expect(result?.preferences?.verbosity).toBe("verbose");
    expect(result?.defaults?.region).toBe("eu-west-1");
  });

  it("translates legacy bestPractices.autoFix=true → preferences.auto_fix=apply", () => {
    const result = adaptUserConfigToAssignee({
      bestPractices: { autoFix: true },
    } as unknown as Parameters<typeof adaptUserConfigToAssignee>[0]);
    expect(result?.preferences?.auto_fix).toBe(AutoFixMode.APPLY);
  });

  it("translates legacy bestPractices.autoFix=false → preferences.auto_fix=ask", () => {
    const result = adaptUserConfigToAssignee({
      bestPractices: { autoFix: false },
    } as unknown as Parameters<typeof adaptUserConfigToAssignee>[0]);
    expect(result?.preferences?.auto_fix).toBe(AutoFixMode.ASK);
  });
});

describe("loadGlobalConfig composition (A2 + A5)", () => {
  it("returns CONFIG_DEFAULTS when every source is empty", async () => {
    const result = await loadGlobalConfig(undefined);
    expect(result.preferences.auto_fix).toBe(AutoFixMode.ASK);
    expect(result.preferences.output_format).toBe("table");
    expect(result.preferences.verbosity).toBe("normal");
  });

  it("env vars beat user config", async () => {
    mockLoadEnvOverrides.mockReturnValueOnce({
      preferences: { auto_fix: AutoFixMode.APPLY },
    });
    const userConfig = {
      bestPractices: { autoFix: false },
    } as unknown as Parameters<typeof loadGlobalConfig>[0];
    const result = await loadGlobalConfig(userConfig);
    // env APPLY > userConfig.bestPractices.autoFix=false → apply wins.
    expect(result.preferences.auto_fix).toBe(AutoFixMode.APPLY);
  });

  it("A5: project yaml beats user config, loses to env", async () => {
    mockLoadEnvOverrides.mockReturnValueOnce({
      preferences: { verbosity: "verbose" },
    });
    mockLoadProjectConfig.mockResolvedValueOnce({
      preferences: {
        verbosity: "quiet",
        output_format: "json",
      },
    });
    const userConfig = {
      preferences: { verbosity: "normal", output_format: "table" },
    } as unknown as Parameters<typeof loadGlobalConfig>[0];

    const result = await loadGlobalConfig(userConfig);

    // verbosity: env (verbose) > project (quiet) > user (normal) → verbose
    expect(result.preferences.verbosity).toBe("verbose");
    // output_format: env has none, project (json) > user (table) → json
    expect(result.preferences.output_format).toBe("json");
  });

  it("A5: project yaml supplies fields that env doesn't have", async () => {
    mockLoadProjectConfig.mockResolvedValueOnce({
      defaults: { region: "ap-southeast-2", tags: { env: "prod" } },
    });
    const result = await loadGlobalConfig(undefined);
    expect(result.defaults?.region).toBe("ap-southeast-2");
    expect(result.defaults?.tags).toEqual({ env: "prod" });
  });

  it("A5: project yaml nested tags merge key-by-key with env tags", async () => {
    mockLoadEnvOverrides.mockReturnValueOnce({
      defaults: { tags: { env: "staging" } },
    });
    mockLoadProjectConfig.mockResolvedValueOnce({
      defaults: { tags: { team: "platform" } },
    });
    const result = await loadGlobalConfig(undefined);
    // Both tags must survive — a previous shallow-merge bug would
    // have wiped `team:platform` when env defined any `tags` key.
    expect(result.defaults?.tags).toEqual({
      env: "staging",
      team: "platform",
    });
  });

  // ── Story 44.1: llm passthrough in adaptUserConfigToAssignee ───────────
  it("passes llm section through adaptUserConfigToAssignee", () => {
    const uc = {
      llm: {
        default: "bedrock/amazon.nova-lite-v1:0",
        plan_generator: "anthropic/claude-sonnet-4-5",
      },
    } as unknown as Parameters<typeof adaptUserConfigToAssignee>[0];
    const result = adaptUserConfigToAssignee(uc);
    expect(result?.llm).toEqual({
      default: "bedrock/amazon.nova-lite-v1:0",
      plan_generator: "anthropic/claude-sonnet-4-5",
    });
  });

  it("passes llm section even when no preferences/defaults/budget exist", () => {
    // This was the bug: only llm → guard didn't trigger
    const uc = {
      llm: { plan_generator: "anthropic/claude-sonnet-4-5" },
    } as unknown as Parameters<typeof adaptUserConfigToAssignee>[0];
    const result = adaptUserConfigToAssignee(uc);
    expect(result?.llm?.["plan_generator"]).toBe("anthropic/claude-sonnet-4-5");
  });

  it("user-level llm config flows through loadGlobalConfig to resolved result", async () => {
    mockLoadEnvOverrides.mockReturnValueOnce({});
    mockLoadProjectConfig.mockResolvedValueOnce(undefined);
    const userConfig = {
      llm: { default: "bedrock/amazon.nova-lite-v1:0" },
    } as unknown as Parameters<typeof loadGlobalConfig>[0];
    const result = await loadGlobalConfig(userConfig);
    expect(result.llm?.["default"]).toBe("bedrock/amazon.nova-lite-v1:0");
  });

  it("A5: env var for ASSIGNEE_AUTO_FIX reaches the resolved config (regression guard)", async () => {
    // Before A2 + A5 wire-up, loadEnvOverrides() was dead code and
    // an operator setting ASSIGNEE_AUTO_FIX=apply saw no effect in
    // fix-applicator. This test locks in the fix end-to-end: even
    // with no project YAML and no user config, the env override
    // flows through loadGlobalConfig() to the final preferences.
    mockLoadEnvOverrides.mockReturnValueOnce({
      preferences: { auto_fix: AutoFixMode.APPLY },
    });
    const result = await loadGlobalConfig(undefined);
    expect(result.preferences.auto_fix).toBe(AutoFixMode.APPLY);
  });
});
