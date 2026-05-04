/**
 * W7-S3 — `assignee version` command tests.
 *
 * Covers:
 *   - Command shape: name, description, --json flag registered.
 *   - --json: emits a compact self-describe JSON blob with required fields.
 *   - --json: cli field is a valid semver (x.y.z).
 *   - --json: all required PR-030 fields present (cli, node, platform, arch, region, auditKeySource).
 *   - RES-1 (W24d): region falls back to ~/.aws/config [default] region when AWS_REGION is absent.
 *   - Without --json: human-readable output is retained (regression guard).
 */

import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { versionCommand, readPackageVersion } from "./version.js";

// ── Command shape tests ───────────────────────────────────────────────────

describe("versionCommand — command shape", () => {
  it("has name 'version'", () => {
    expect(versionCommand.name()).toBe("version");
  });

  it("has a non-empty description", () => {
    expect(versionCommand.description().length).toBeGreaterThan(0);
  });

  it("registers --json flag as a boolean option", () => {
    const jsonOpt = versionCommand.options.find((o) => o.long === "--json");
    expect(jsonOpt).toBeDefined();
    // Boolean flag: no required or optional argument
    expect(jsonOpt?.required).toBe(false);
    expect(jsonOpt?.optional).toBe(false);
  });
});

// ── readPackageVersion helper ─────────────────────────────────────────────

describe("readPackageVersion", () => {
  it("returns a non-empty string", () => {
    const version = readPackageVersion();
    expect(typeof version).toBe("string");
    expect(version.length).toBeGreaterThan(0);
  });

  it("returns a semver-shaped string (x.y.z)", () => {
    const version = readPackageVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

// ── --json output tests ───────────────────────────────────────────────────

describe("versionCommand — --json output", () => {
  let writtenChunks: string[];
  let originalStdoutWrite: typeof process.stdout.write;

  beforeEach(() => {
    // Commander is a singleton; reset parsed option values so --json from a
    // previous test does not bleed into this one.
    (
      versionCommand as unknown as {
        _optionValues: Record<string, unknown>;
        _optionValueSources: Record<string, unknown>;
      }
    )._optionValues = {};
    (
      versionCommand as unknown as {
        _optionValueSources: Record<string, unknown>;
      }
    )._optionValueSources = {};

    writtenChunks = [];
    originalStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      writtenChunks.push(
        typeof chunk === "string"
          ? chunk
          : Buffer.from(chunk).toString("utf-8"),
      );
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = originalStdoutWrite;
  });

  it("emits a single JSON line with a 'cli' string field (PR-030)", async () => {
    await versionCommand.parseAsync(["--json"], { from: "user" });

    const raw = writtenChunks.join("").trim();
    expect(raw.length).toBeGreaterThan(0);

    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(typeof parsed["cli"]).toBe("string");
    expect((parsed["cli"] as string).length).toBeGreaterThan(0);
  });

  it("cli field in JSON matches readPackageVersion() (PR-030)", async () => {
    await versionCommand.parseAsync(["--json"], { from: "user" });

    const raw = writtenChunks.join("").trim();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed["cli"]).toBe(readPackageVersion());
  });

  it("JSON output contains all required PR-030 fields: cli, node, platform, arch, region, auditKeySource", async () => {
    await versionCommand.parseAsync(["--json"], { from: "user" });

    const raw = writtenChunks.join("").trim();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const keys = Object.keys(parsed);
    expect(keys).toContain("cli");
    expect(keys).toContain("node");
    expect(keys).toContain("platform");
    expect(keys).toContain("arch");
    expect(keys).toContain("region");
    expect(keys).toContain("auditKeySource");
  });

  it("JSON output has exactly the required fields (no undocumented extras)", async () => {
    await versionCommand.parseAsync(["--json"], { from: "user" });

    const raw = writtenChunks.join("").trim();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const keys = Object.keys(parsed).sort();

    // Core PR-030 required fields are always present.
    const requiredKeys = [
      "arch",
      "auditKeySource",
      "cli",
      "node",
      "platform",
      "region",
    ];
    for (const k of requiredKeys) {
      expect(keys).toContain(k);
    }

    // F037: auditKeyFileMode is conditionally present (only when the audit-key
    // file exists and is readable). Every key in the output must be in the
    // allowed set — this guards against truly undocumented extras.
    const allowedKeys = new Set([...requiredKeys, "auditKeyFileMode"]);
    for (const k of keys) {
      expect(allowedKeys).toContain(k);
    }

    // If present, auditKeyFileMode must be a positive integer (stat mode masked to 0o777).
    if ("auditKeyFileMode" in parsed) {
      expect(typeof parsed["auditKeyFileMode"]).toBe("number");
      expect(parsed["auditKeyFileMode"] as number).toBeGreaterThan(0);
    }
  });

  it("--json output is a single JSON object (not array, not primitive)", async () => {
    await versionCommand.parseAsync(["--json"], { from: "user" });

    const raw = writtenChunks.join("").trim();
    const parsed = JSON.parse(raw);
    expect(parsed).not.toBeNull();
    expect(typeof parsed).toBe("object");
    expect(Array.isArray(parsed)).toBe(false);
  });

  it("auditKeySource is 'env' when ASSIGNEE_AUDIT_KEY is set (PR-030)", async () => {
    const original = process.env["ASSIGNEE_AUDIT_KEY"];
    process.env["ASSIGNEE_AUDIT_KEY"] = "a".repeat(64); // meets min-length floor
    try {
      await versionCommand.parseAsync(["--json"], { from: "user" });
      const raw = writtenChunks.join("").trim();
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      expect(parsed["auditKeySource"]).toBe("env");
    } finally {
      if (original === undefined) {
        delete process.env["ASSIGNEE_AUDIT_KEY"];
      } else {
        process.env["ASSIGNEE_AUDIT_KEY"] = original;
      }
    }
  });

  it("auditKeySource is 'file' when ASSIGNEE_AUDIT_KEY is absent (PR-030)", async () => {
    const original = process.env["ASSIGNEE_AUDIT_KEY"];
    delete process.env["ASSIGNEE_AUDIT_KEY"];
    try {
      await versionCommand.parseAsync(["--json"], { from: "user" });
      const raw = writtenChunks.join("").trim();
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      expect(parsed["auditKeySource"]).toBe("file");
    } finally {
      if (original !== undefined) {
        process.env["ASSIGNEE_AUDIT_KEY"] = original;
      }
    }
  });

  it("region field reflects AWS_REGION env var when set (PR-030)", async () => {
    const original = process.env["AWS_REGION"];
    process.env["AWS_REGION"] = "us-gov-west-1";
    try {
      await versionCommand.parseAsync(["--json"], { from: "user" });
      const raw = writtenChunks.join("").trim();
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      expect(parsed["region"]).toBe("us-gov-west-1");
    } finally {
      if (original === undefined) {
        delete process.env["AWS_REGION"];
      } else {
        process.env["AWS_REGION"] = original;
      }
    }
  });

  it("region field is 'unset' when AWS_REGION is absent and no ~/.aws/config region (PR-030)", async () => {
    // Write an empty AWS config file so detectAwsConfigDefaultRegion returns
    // undefined regardless of the developer's real ~/.aws/config.
    const dir = mkdtempSync(join(tmpdir(), "assignee-version-test-"));
    const cfgPath = join(dir, "config");
    writeFileSync(cfgPath, "# empty — no region\n", "utf8");

    const originalRegion = process.env["AWS_REGION"];
    const originalCfg = process.env["AWS_CONFIG_FILE"];
    delete process.env["AWS_REGION"];
    process.env["AWS_CONFIG_FILE"] = cfgPath;
    try {
      await versionCommand.parseAsync(["--json"], { from: "user" });
      const raw = writtenChunks.join("").trim();
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      expect(parsed["region"]).toBe("unset");
    } finally {
      if (originalRegion !== undefined) {
        process.env["AWS_REGION"] = originalRegion;
      }
      if (originalCfg !== undefined) {
        process.env["AWS_CONFIG_FILE"] = originalCfg;
      } else {
        delete process.env["AWS_CONFIG_FILE"];
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("region field reflects ~/.aws/config [default] region when AWS_REGION is absent (RES-1 W24d)", async () => {
    // Write a temporary AWS config with a [default] region.
    const dir = mkdtempSync(join(tmpdir(), "assignee-version-test-"));
    const cfgPath = join(dir, "config");
    writeFileSync(cfgPath, "[default]\nregion = eu-central-1\n", "utf8");

    const originalRegion = process.env["AWS_REGION"];
    const originalCfg = process.env["AWS_CONFIG_FILE"];
    delete process.env["AWS_REGION"];
    process.env["AWS_CONFIG_FILE"] = cfgPath;
    try {
      await versionCommand.parseAsync(["--json"], { from: "user" });
      const raw = writtenChunks.join("").trim();
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      expect(parsed["region"]).toBe("eu-central-1");
    } finally {
      if (originalRegion !== undefined) {
        process.env["AWS_REGION"] = originalRegion;
      }
      if (originalCfg !== undefined) {
        process.env["AWS_CONFIG_FILE"] = originalCfg;
      } else {
        delete process.env["AWS_CONFIG_FILE"];
      }
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── non-json regression guard ─────────────────────────────────────────────

describe("versionCommand — human-readable output (no --json)", () => {
  let writtenChunks: string[];
  let originalStdoutWrite: typeof process.stdout.write;

  beforeEach(() => {
    // Commander is a singleton; reset parsed option values so --json from a
    // previous test does not bleed into this one.
    (
      versionCommand as unknown as {
        _optionValues: Record<string, unknown>;
        _optionValueSources: Record<string, unknown>;
      }
    )._optionValues = {};
    (
      versionCommand as unknown as {
        _optionValueSources: Record<string, unknown>;
      }
    )._optionValueSources = {};

    writtenChunks = [];
    originalStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      writtenChunks.push(
        typeof chunk === "string"
          ? chunk
          : Buffer.from(chunk).toString("utf-8"),
      );
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = originalStdoutWrite;
  });

  it("without --json emits human-readable output containing the version", async () => {
    await versionCommand.parseAsync([], { from: "user" });

    const raw = writtenChunks.join("");
    expect(raw).toContain(readPackageVersion());
    // Should NOT be a JSON string when --json is not passed
    expect(() => {
      const trimmed = raw.trim();
      // If it starts with '{' it might accidentally be JSON — assert it
      // is NOT a well-formed JSON object with only a 'version' key.
      if (trimmed.startsWith("{")) {
        const parsed = JSON.parse(trimmed) as Record<string, unknown>;
        expect(Object.keys(parsed)).not.toStrictEqual(["version"]);
      }
    }).not.toThrow();
    // Human-readable: contains "node" and "platform" lines
    expect(raw).toContain("node");
    expect(raw).toContain("platform");
  });
});
