import { describe, it, expect } from "vitest";
import { mergeConfigs } from "./merge-configs.js";
import type {
  ResourceField,
  OrgResourceConfig,
  UserResourceConfig,
} from "../index.js";

const RESOURCE_TYPE = "AWS::S3::Bucket";

/** Helper to create a minimal ResourceField */
function field(name: string, initialValue?: unknown): ResourceField {
  return {
    name,
    question: {
      type: "boolean",
      label: `Configure ${name}?`,
      ...(initialValue !== undefined ? { initialValue } : {}),
    },
  };
}

// ── Legacy 4-arg call tests (backward compatibility) ─────────────────────

describe("mergeConfigs (legacy 4-arg signature)", () => {
  describe("locked org field", () => {
    it("beats user config + plugin default", () => {
      const orgPolicy: OrgResourceConfig = {
        [RESOURCE_TYPE]: {
          Encryption: { policy: "locked", value: "AES256" },
        },
      };
      const userConfig: UserResourceConfig = {
        [RESOURCE_TYPE]: { Encryption: "aws:kms" },
      };
      const fields = [field("Encryption", "none")];

      const result = mergeConfigs(fields, orgPolicy, userConfig, RESOURCE_TYPE);

      expect(result["Encryption"]).toEqual({
        policy: "never_ask",
        value: "AES256",
        source: "org_locked",
      });
    });

    it("locks even without user config or plugin default", () => {
      const orgPolicy: OrgResourceConfig = {
        [RESOURCE_TYPE]: {
          Versioning: { policy: "locked", value: true },
        },
      };

      const result = mergeConfigs(
        [field("Versioning")],
        orgPolicy,
        undefined,
        RESOURCE_TYPE,
      );

      expect(result["Versioning"]).toEqual({
        policy: "never_ask",
        value: true,
        source: "org_locked",
      });
    });
  });

  describe("always_ask org field", () => {
    it("forces prompt even if user config has a value", () => {
      const orgPolicy: OrgResourceConfig = {
        [RESOURCE_TYPE]: {
          Region: { policy: "always_ask" },
        },
      };
      const userConfig: UserResourceConfig = {
        [RESOURCE_TYPE]: { Region: "us-west-2" },
      };

      const result = mergeConfigs(
        [field("Region", "us-east-1")],
        orgPolicy,
        userConfig,
        RESOURCE_TYPE,
      );

      expect(result["Region"]).toEqual({
        policy: "always_ask",
        source: "org_default",
      });
    });
  });

  describe("default org field beaten by user config", () => {
    it("user config wins over org default", () => {
      const orgPolicy: OrgResourceConfig = {
        [RESOURCE_TYPE]: {
          MemorySize: { policy: "default", value: 128 },
        },
      };
      const userConfig: UserResourceConfig = {
        [RESOURCE_TYPE]: { MemorySize: 256 },
      };

      const result = mergeConfigs(
        [field("MemorySize", 64)],
        orgPolicy,
        userConfig,
        RESOURCE_TYPE,
      );

      expect(result["MemorySize"]).toEqual({
        policy: "ask_if_not_set",
        value: 256,
        source: "user_config",
      });
    });

    it("org default used when user has no preference", () => {
      const orgPolicy: OrgResourceConfig = {
        [RESOURCE_TYPE]: {
          MemorySize: { policy: "default", value: 128 },
        },
      };

      const result = mergeConfigs(
        [field("MemorySize", 64)],
        orgPolicy,
        undefined,
        RESOURCE_TYPE,
      );

      expect(result["MemorySize"]).toEqual({
        policy: "ask_if_not_set",
        value: 128,
        source: "org_default",
      });
    });
  });

  describe("user config beats plugin default", () => {
    it("uses user config value over plugin initialValue", () => {
      const userConfig: UserResourceConfig = {
        [RESOURCE_TYPE]: { Timeout: 30 },
      };

      const result = mergeConfigs(
        [field("Timeout", 60)],
        undefined,
        userConfig,
        RESOURCE_TYPE,
      );

      expect(result["Timeout"]).toEqual({
        policy: "ask_if_not_set",
        value: 30,
        source: "user_config",
      });
    });
  });

  describe("missing user config falls back to plugin default", () => {
    it("uses plugin initialValue when no user config or org policy", () => {
      const result = mergeConfigs(
        [field("BucketName", "my-default-bucket")],
        undefined,
        undefined,
        RESOURCE_TYPE,
      );

      expect(result["BucketName"]).toEqual({
        policy: "ask_if_not_set",
        value: "my-default-bucket",
        source: "plugin_default",
      });
    });
  });

  describe("missing org + user config → plugin default only", () => {
    it("returns always_ask when no defaults anywhere", () => {
      const result = mergeConfigs(
        [field("CustomField")],
        undefined,
        undefined,
        RESOURCE_TYPE,
      );

      expect(result["CustomField"]).toEqual({
        policy: "always_ask",
        source: "plugin_default",
      });
    });

    it("returns plugin default when available", () => {
      const result = mergeConfigs(
        [field("HasDefault", true)],
        undefined,
        undefined,
        RESOURCE_TYPE,
      );

      expect(result["HasDefault"]).toEqual({
        policy: "ask_if_not_set",
        value: true,
        source: "plugin_default",
      });
    });
  });

  describe("multiple fields in one call", () => {
    it("resolves each field independently", () => {
      const orgPolicy: OrgResourceConfig = {
        [RESOURCE_TYPE]: {
          Encryption: { policy: "locked", value: "AES256" },
          Region: { policy: "default", value: "eu-west-1" },
        },
      };
      const userConfig: UserResourceConfig = {
        [RESOURCE_TYPE]: { Region: "us-east-1", Timeout: 30 },
      };
      const fields = [
        field("Encryption", "none"),
        field("Region", "us-west-2"),
        field("Timeout", 60),
        field("NoDefault"),
      ];

      const result = mergeConfigs(fields, orgPolicy, userConfig, RESOURCE_TYPE);

      expect(result["Encryption"]?.source).toBe("org_locked");
      expect(result["Region"]?.source).toBe("user_config");
      expect(result["Timeout"]?.source).toBe("user_config");
      expect(result["NoDefault"]?.policy).toBe("always_ask");
    });
  });
});

// ── New 6-level precedence tests (Story 27.2) ───────────────────────────

describe("mergeConfigs (6-level options object)", () => {
  describe("CLI flag overrides all non-locked levels", () => {
    it("CLI flag wins over env var, project, user, org default, plugin default", () => {
      const result = mergeConfigs({
        pluginFields: [field("Region", "plugin-default")],
        resourceType: RESOURCE_TYPE,
        cliFlags: { Region: "from-cli" },
        envOverrides: { Region: "from-env" },
        projectConfig: { [RESOURCE_TYPE]: { Region: "from-project" } },
        userConfig: { [RESOURCE_TYPE]: { Region: "from-user" } },
        orgPolicy: {
          [RESOURCE_TYPE]: {
            Region: { policy: "default", value: "from-org" },
          },
        },
      });

      expect(result["Region"]).toEqual({
        policy: "ask_if_not_set",
        value: "from-cli",
        source: "cli_flag",
      });
    });
  });

  describe("env var overrides project, user, org default, plugin default", () => {
    it("env var wins over lower levels", () => {
      const result = mergeConfigs({
        pluginFields: [field("Region", "plugin-default")],
        resourceType: RESOURCE_TYPE,
        envOverrides: { Region: "from-env" },
        projectConfig: { [RESOURCE_TYPE]: { Region: "from-project" } },
        userConfig: { [RESOURCE_TYPE]: { Region: "from-user" } },
      });

      expect(result["Region"]).toEqual({
        policy: "ask_if_not_set",
        value: "from-env",
        source: "env_var",
      });
    });
  });

  describe("project config overrides user, org default, plugin default", () => {
    it("project config wins over user config", () => {
      const result = mergeConfigs({
        pluginFields: [field("Region", "plugin-default")],
        resourceType: RESOURCE_TYPE,
        projectConfig: { [RESOURCE_TYPE]: { Region: "from-project" } },
        userConfig: { [RESOURCE_TYPE]: { Region: "from-user" } },
      });

      expect(result["Region"]).toEqual({
        policy: "ask_if_not_set",
        value: "from-project",
        source: "project_config",
      });
    });

    it("project config wins over org default", () => {
      const result = mergeConfigs({
        pluginFields: [field("Region", "plugin-default")],
        resourceType: RESOURCE_TYPE,
        projectConfig: { [RESOURCE_TYPE]: { Region: "from-project" } },
        orgPolicy: {
          [RESOURCE_TYPE]: {
            Region: { policy: "default", value: "from-org" },
          },
        },
      });

      expect(result["Region"]).toEqual({
        policy: "ask_if_not_set",
        value: "from-project",
        source: "project_config",
      });
    });
  });

  describe("org locked overrides CLI flags", () => {
    it("locked beats CLI flag", () => {
      const result = mergeConfigs({
        pluginFields: [field("Encryption", "none")],
        resourceType: RESOURCE_TYPE,
        cliFlags: { Encryption: "from-cli" },
        orgPolicy: {
          [RESOURCE_TYPE]: {
            Encryption: { policy: "locked", value: "AES256" },
          },
        },
      });

      expect(result["Encryption"]).toEqual({
        policy: "never_ask",
        value: "AES256",
        source: "org_locked",
      });
    });
  });

  describe("org always_ask forces prompt even with CLI flag", () => {
    it("always_ask overrides CLI flag", () => {
      const result = mergeConfigs({
        pluginFields: [field("Region", "default")],
        resourceType: RESOURCE_TYPE,
        cliFlags: { Region: "from-cli" },
        orgPolicy: {
          [RESOURCE_TYPE]: { Region: { policy: "always_ask" } },
        },
      });

      expect(result["Region"]).toEqual({
        policy: "always_ask",
        source: "org_default",
      });
    });
  });

  describe("empty/undefined at each level falls through correctly", () => {
    it("undefined CLI flags falls through to env var", () => {
      const result = mergeConfigs({
        pluginFields: [field("Region")],
        resourceType: RESOURCE_TYPE,
        cliFlags: {},
        envOverrides: { Region: "from-env" },
      });

      expect(result["Region"]?.source).toBe("env_var");
    });

    it("undefined env var falls through to project config", () => {
      const result = mergeConfigs({
        pluginFields: [field("Region")],
        resourceType: RESOURCE_TYPE,
        envOverrides: {},
        projectConfig: { [RESOURCE_TYPE]: { Region: "from-project" } },
      });

      expect(result["Region"]?.source).toBe("project_config");
    });

    it("undefined project config falls through to user config", () => {
      const result = mergeConfigs({
        pluginFields: [field("Region")],
        resourceType: RESOURCE_TYPE,
        projectConfig: {},
        userConfig: { [RESOURCE_TYPE]: { Region: "from-user" } },
      });

      expect(result["Region"]?.source).toBe("user_config");
    });

    it("all undefined falls through to plugin default", () => {
      const result = mergeConfigs({
        pluginFields: [field("Region", "us-east-1")],
        resourceType: RESOURCE_TYPE,
      });

      expect(result["Region"]).toEqual({
        policy: "ask_if_not_set",
        value: "us-east-1",
        source: "plugin_default",
      });
    });

    it("no defaults anywhere → always_ask", () => {
      const result = mergeConfigs({
        pluginFields: [field("CustomField")],
        resourceType: RESOURCE_TYPE,
      });

      expect(result["CustomField"]).toEqual({
        policy: "always_ask",
        source: "plugin_default",
      });
    });
  });
});
