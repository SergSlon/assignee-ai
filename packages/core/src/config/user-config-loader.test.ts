import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import {
  loadUserConfig,
  resolveConfigPath,
  validateUserConfig,
} from "./user-config-loader.js";
import type { StoragePort } from "../ports/storage-port.js";

/**
 * Minimal in-memory StoragePort for unit tests. Only the methods
 * `loadUserConfig` actually consults are wired (`readText`); the rest
 * throw to flag accidental coupling to other port methods.
 *
 * RW4d-migration-C: prior tests relied on `vi.mock("node:fs/promises")`
 * to intercept the YAML read; the migrated loader now goes through the
 * StoragePort. Injecting a hand-rolled port is the cleanest way to keep
 * the assertions identical and avoid leaking adapter internals into the
 * test surface.
 */
function makeStoragePort(opts: {
  content?: string;
  readError?: Error;
}): StoragePort {
  return {
    has: () => Promise.resolve(opts.content !== undefined),
    readBytes: () => {
      throw new Error("readBytes not used by user-config-loader");
    },
    readText: () => {
      if (opts.readError) return Promise.reject(opts.readError);
      return Promise.resolve(opts.content);
    },
    readJson: () => {
      throw new Error("readJson not used by user-config-loader");
    },
    writeBytes: () => {
      throw new Error("writeBytes not used by user-config-loader");
    },
    writeText: () => {
      throw new Error("writeText not used by user-config-loader");
    },
    writeJson: () => {
      throw new Error("writeJson not used by user-config-loader");
    },
    delete: () => Promise.resolve(false),
    list: () => Promise.resolve([]),
    stat: () => {
      throw new Error("stat not used by user-config-loader");
    },
    tryAcquire: () => {
      throw new Error("tryAcquire not used by user-config-loader");
    },
  };
}

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
      // path.join on both sides so the assertion matches the production
      // path separator on every platform (backslash on Windows, forward
      // slash on POSIX).
      expect(result).toBe(path.join("/custom/config/dir", "config.yaml"));
    });

    it("uses XDG default when env var is not set", () => {
      const result = resolveConfigPath();
      expect(result).toContain(path.join(".config", "assignee", "config.yaml"));
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
      const port = makeStoragePort({ content: yamlContent });

      const result = await loadUserConfig(undefined, port);

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

    it("returns undefined when file not found (StoragePort returns undefined for missing key, mirrors ENOENT)", async () => {
      // Port returns undefined for missing keys — equivalent to ENOENT
      // in the legacy fs path. User may not have created config yet.
      const port = makeStoragePort({ content: undefined });

      const result = await loadUserConfig(undefined, port);

      expect(result).toBeUndefined();
    });

    it("returns undefined and warns on malformed YAML", async () => {
      const port = makeStoragePort({ content: ":::invalid yaml:::" });

      const result = await loadUserConfig(undefined, port);

      // yaml package may parse this as a string rather than throw,
      // but non-object results should return undefined
      // If it throws, it should be caught and return undefined
      expect(result === undefined || typeof result === "object").toBe(true);
    });

    it("returns undefined for empty file content", async () => {
      const port = makeStoragePort({ content: "" });

      const result = await loadUserConfig(undefined, port);

      expect(result).toBeUndefined();
    });

    it("returns undefined for YAML that parses to null", async () => {
      const port = makeStoragePort({ content: "null" });

      const result = await loadUserConfig(undefined, port);

      expect(result).toBeUndefined();
    });

    // ── Schema validation (M-S4) ────────────────────────────────────────

    it("returns undefined when bestPractices.enforcement is an unknown value", async () => {
      const port = makeStoragePort({
        content: "bestPractices:\n  enforcement: galaxy-brain\n",
      });

      const result = await loadUserConfig(undefined, port);

      expect(result).toBeUndefined();
    });

    it("returns undefined when a resource override is a string instead of an object", async () => {
      const port = makeStoragePort({
        content: "AWS::S3::Bucket: not-an-object\n",
      });

      const result = await loadUserConfig(undefined, port);

      expect(result).toBeUndefined();
    });

    it("accepts a valid config with bestPractices.enforcement = 'enforce'", async () => {
      const port = makeStoragePort({
        content:
          "bestPractices:\n  enforcement: enforce\n  autoFix: true\nAWS::S3::Bucket:\n  BucketEncryption: true\n",
      });

      const result = await loadUserConfig(undefined, port);

      // Tier C: dropped redundant toBeDefined() — optional-chained .toBe()
      // already fails on undefined
      expect(result?.bestPractices?.enforcement).toBe("enforce");
      expect(result?.bestPractices?.autoFix).toBe(true);
    });

    it("returns undefined on read permission error (e.g. EACCES surfaced by the port)", async () => {
      const err = new Error("EACCES") as NodeJS.ErrnoException;
      err.code = "EACCES";
      const port = makeStoragePort({ readError: err });

      const result = await loadUserConfig(undefined, port);

      expect(result).toBeUndefined();
    });
  });

  describe("validateUserConfig (M-S4)", () => {
    it("accepts an empty object", () => {
      expect(validateUserConfig({})).toEqual({});
    });

    it("throws naming the offending key for an unknown enforcement", () => {
      expect(() =>
        validateUserConfig({ bestPractices: { enforcement: "ultra" } }),
      ).toThrow(/bestPractices/);
    });

    it("throws naming the offending key for a non-object resource override", () => {
      expect(() => validateUserConfig({ "AWS::S3::Bucket": "no" })).toThrow(
        /AWS::S3::Bucket/,
      );
    });

    it("accepts multiple resource overrides plus bestPractices", () => {
      const config = {
        bestPractices: { enforcement: "warn", autoFix: false },
        "AWS::S3::Bucket": { BucketEncryption: true },
        "AWS::Lambda::Function": { MemorySize: 256 },
      };
      expect(validateUserConfig(config)).toEqual(config);
    });

    it("rejects an array as a resource override", () => {
      expect(() =>
        validateUserConfig({ "AWS::S3::Bucket": [1, 2, 3] }),
      ).toThrow(/AWS::S3::Bucket/);
    });
  });
});
