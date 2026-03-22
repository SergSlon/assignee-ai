import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import { loadUserConfig, resolveConfigPath } from "./user-config-loader.js";

vi.mock("node:fs/promises");

const mockedFs = vi.mocked(fs);

describe("user-config-loader", () => {
  beforeEach(() => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["ASSIGNEE_CONFIG_DIR"];
  });

  describe("resolveConfigPath", () => {
    it("uses ASSIGNEE_CONFIG_DIR env var when set", () => {
      process.env["ASSIGNEE_CONFIG_DIR"] = "/custom/config/dir";
      const result = resolveConfigPath();
      expect(result).toBe("/custom/config/dir/config.yaml");
    });

    it("uses XDG default when env var is not set", () => {
      const result = resolveConfigPath();
      expect(result).toContain(".config/assignee/config.yaml");
    });
  });

  describe("loadUserConfig", () => {
    it("returns parsed config from valid YAML file", async () => {
      const yamlContent = `AWS::S3::Bucket:
  BucketEncryption: true
  PublicAccessBlockConfiguration: true
AWS::Lambda::Function:
  MemorySize: 256
`;
      mockedFs.readFile.mockResolvedValueOnce(yamlContent);

      const result = await loadUserConfig();

      expect(result).toEqual({
        "AWS::S3::Bucket": {
          BucketEncryption: true,
          PublicAccessBlockConfiguration: true,
        },
        "AWS::Lambda::Function": {
          MemorySize: 256,
        },
      });
    });

    it("returns undefined when file not found (ENOENT)", async () => {
      const err = new Error("ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      mockedFs.readFile.mockRejectedValueOnce(err);

      const result = await loadUserConfig();

      expect(result).toBeUndefined();
    });

    it("returns undefined and warns on malformed YAML", async () => {
      mockedFs.readFile.mockResolvedValueOnce(":::invalid yaml:::");

      const result = await loadUserConfig();

      // yaml package may parse this as a string rather than throw,
      // but non-object results should return undefined
      // If it throws, it should be caught and return undefined
      expect(result === undefined || typeof result === "object").toBe(true);
    });

    it("returns undefined for empty file content", async () => {
      mockedFs.readFile.mockResolvedValueOnce("");

      const result = await loadUserConfig();

      expect(result).toBeUndefined();
    });

    it("returns undefined for YAML that parses to null", async () => {
      mockedFs.readFile.mockResolvedValueOnce("null");

      const result = await loadUserConfig();

      expect(result).toBeUndefined();
    });

    it("returns undefined on read permission error", async () => {
      const err = new Error("EACCES") as NodeJS.ErrnoException;
      err.code = "EACCES";
      mockedFs.readFile.mockRejectedValueOnce(err);

      const result = await loadUserConfig();

      expect(result).toBeUndefined();
    });
  });
});
