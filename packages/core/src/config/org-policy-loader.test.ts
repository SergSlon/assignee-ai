import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from "vitest";
import * as fs from "node:fs/promises";
import { loadLocalOrgPolicy, mergeOrgPolicies } from "./org-policy-loader.js";
import type { OrgResourceConfig } from "./resource-policy.js";

vi.mock("node:fs/promises");

const mockedFs = vi.mocked(fs);

describe("org-policy-loader", () => {
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

  describe("loadLocalOrgPolicy", () => {
    it("returns undefined when no policy files exist", async () => {
      mockedFs.readFile.mockRejectedValue(
        Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
      );

      const result = await loadLocalOrgPolicy("/tmp/test-project");
      expect(result).toBeUndefined();
    });

    it("loads project-level policy from .assignee/org-policy.yaml", async () => {
      const yaml = `
"AWS::S3::Bucket":
  BucketEncryption:
    policy: locked
    value:
      SSEAlgorithm: "aws:kms"
`;
      mockedFs.readFile.mockImplementation(async (filePath) => {
        const p = String(filePath);
        if (
          p.includes(".assignee/org-policy.yaml") &&
          p.includes("test-project")
        ) {
          return yaml;
        }
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      const result = await loadLocalOrgPolicy("/tmp/test-project");
      // Tier C: dropped redundant toBeDefined() — assert the deep property
      // directly. The non-null chain `result!["..."]!` already crashes on
      // undefined with a clear error.
      expect(result!["AWS::S3::Bucket"]!["BucketEncryption"]!.policy).toBe(
        "locked",
      );
    });

    it("loads user-level policy from ~/.config/assignee/org-policy.yaml", async () => {
      const yaml = `
"AWS::Lambda::Function":
  Runtime:
    policy: always_ask
`;
      mockedFs.readFile.mockImplementation(async (filePath) => {
        const p = String(filePath);
        if (p.includes(".config/assignee/org-policy.yaml")) {
          return yaml;
        }
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      const result = await loadLocalOrgPolicy("/tmp/test-project");
      // Tier C: dropped redundant toBeDefined()
      expect(result!["AWS::Lambda::Function"]!["Runtime"]!.policy).toBe(
        "always_ask",
      );
    });

    it("project-level policy overrides user-level policy on field collision", async () => {
      const projectYaml = `
"AWS::S3::Bucket":
  Tags:
    policy: locked
    value:
      env: production
`;
      const userYaml = `
"AWS::S3::Bucket":
  Tags:
    policy: default
    value:
      env: development
  BucketEncryption:
    policy: locked
    value:
      SSEAlgorithm: "aws:kms"
`;

      mockedFs.readFile.mockImplementation(async (filePath) => {
        const p = String(filePath);
        if (
          p.includes("test-project") &&
          p.includes(".assignee/org-policy.yaml")
        ) {
          return projectYaml;
        }
        if (p.includes(".config/assignee/org-policy.yaml")) {
          return userYaml;
        }
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      const result = await loadLocalOrgPolicy("/tmp/test-project");
      // Tier C: dropped redundant toBeDefined()
      // Project-level Tags wins
      expect(result!["AWS::S3::Bucket"]!["Tags"]!.policy).toBe("locked");
      expect(
        (
          result!["AWS::S3::Bucket"]!["Tags"] as {
            value: Record<string, string>;
          }
        ).value["env"],
      ).toBe("production");
      // User-level BucketEncryption preserved
      expect(result!["AWS::S3::Bucket"]!["BucketEncryption"]!.policy).toBe(
        "locked",
      );
    });

    it("locked field produces correct structure", async () => {
      const yaml = `
"AWS::S3::Bucket":
  PublicAccessBlockConfiguration:
    policy: locked
    value: true
`;
      mockedFs.readFile.mockImplementation(async (filePath) => {
        const p = String(filePath);
        if (p.includes("test-project")) return yaml;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      const result = await loadLocalOrgPolicy("/tmp/test-project");
      // Tier C: dropped redundant toBeDefined()
      const field =
        result!["AWS::S3::Bucket"]!["PublicAccessBlockConfiguration"]!;
      expect(field.policy).toBe("locked");
      expect(field.value).toBe(true);
    });

    it("default field produces correct structure", async () => {
      const yaml = `
"AWS::S3::Bucket":
  Tags:
    policy: default
    value:
      cost-center: "CC-1234"
`;
      mockedFs.readFile.mockImplementation(async (filePath) => {
        const p = String(filePath);
        if (p.includes("test-project")) return yaml;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      const result = await loadLocalOrgPolicy("/tmp/test-project");
      // Tier C: dropped redundant toBeDefined()
      const field = result!["AWS::S3::Bucket"]!["Tags"]!;
      expect(field.policy).toBe("default");
      expect(field.value).toEqual({ "cost-center": "CC-1234" });
    });

    it("always_ask field produces correct structure", async () => {
      const yaml = `
"AWS::Lambda::Function":
  Runtime:
    policy: always_ask
`;
      mockedFs.readFile.mockImplementation(async (filePath) => {
        const p = String(filePath);
        if (p.includes("test-project")) return yaml;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      const result = await loadLocalOrgPolicy("/tmp/test-project");
      // Tier C: dropped redundant toBeDefined()
      const field = result!["AWS::Lambda::Function"]!["Runtime"]!;
      expect(field.policy).toBe("always_ask");
      expect(field.value).toBeUndefined();
    });

    it("returns undefined and warns on malformed YAML", async () => {
      mockedFs.readFile.mockImplementation(async (filePath) => {
        const p = String(filePath);
        if (p.includes("test-project")) return "not: [valid: yaml: {{";
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      const result = await loadLocalOrgPolicy("/tmp/test-project");
      expect(result).toBeUndefined();
    });

    it("returns undefined and warns when field config is not an object", async () => {
      const yaml = `
"AWS::S3::Bucket":
  Tags: "just a string"
`;
      mockedFs.readFile.mockImplementation(async (filePath) => {
        const p = String(filePath);
        if (p.includes("test-project")) return yaml;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      const result = await loadLocalOrgPolicy("/tmp/test-project");
      expect(result).toBeUndefined();
    });

    it("returns undefined and warns when policy value is invalid", async () => {
      const yaml = `
"AWS::S3::Bucket":
  Tags:
    policy: forbidden
    value: something
`;
      mockedFs.readFile.mockImplementation(async (filePath) => {
        const p = String(filePath);
        if (p.includes("test-project")) return yaml;
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      });

      const result = await loadLocalOrgPolicy("/tmp/test-project");
      expect(result).toBeUndefined();
    });
  });

  describe("mergeOrgPolicies", () => {
    it("merges two policies with high winning on collision", () => {
      const low: OrgResourceConfig = {
        "AWS::S3::Bucket": {
          Tags: { policy: "default", value: { env: "dev" } },
          Encryption: { policy: "locked", value: "AES256" },
        },
      };
      const high: OrgResourceConfig = {
        "AWS::S3::Bucket": {
          Tags: { policy: "locked", value: { env: "prod" } },
        },
        "AWS::Lambda::Function": {
          Runtime: { policy: "always_ask" },
        },
      };

      const result = mergeOrgPolicies(low, high);

      // Tags: high wins
      expect(result["AWS::S3::Bucket"]!["Tags"]!.policy).toBe("locked");
      // Encryption: from low, preserved
      expect(result["AWS::S3::Bucket"]!["Encryption"]!.policy).toBe("locked");
      // Lambda: from high only
      expect(result["AWS::Lambda::Function"]!["Runtime"]!.policy).toBe(
        "always_ask",
      );
    });

    it("preserves resource types unique to each policy", () => {
      const low: OrgResourceConfig = {
        "AWS::S3::Bucket": {
          Tags: { policy: "default", value: {} },
        },
      };
      const high: OrgResourceConfig = {
        "AWS::EC2::Instance": {
          InstanceType: { policy: "locked", value: "t3.micro" },
        },
      };

      const result = mergeOrgPolicies(low, high);
      // Tier C: strengthened — assert the actual config shape, not just
      // defined-ness. mergeOrgPolicies must preserve the unique fields
      // from both inputs.
      expect(result["AWS::S3::Bucket"]).toMatchObject({
        Tags: { policy: "default" },
      });
      expect(result["AWS::EC2::Instance"]).toMatchObject({
        InstanceType: { policy: "locked", value: "t3.micro" },
      });
    });
  });
});
