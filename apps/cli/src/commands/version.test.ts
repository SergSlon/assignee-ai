/**
 * W7-S3 — `assignee version` command tests.
 *
 * Covers:
 *   - Command shape: name, description, --json flag registered.
 *   - --json: emits a compact self-describe JSON blob with required fields.
 *   - --json: cli field is a valid semver (x.y.z).
 *   - --json: all required PR-030 fields present (cli, node, platform, arch, region, auditKeySource).
 *   - Without --json: human-readable output is retained (regression guard).
 */

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

  it("JSON output has exactly the PR-030 required fields (no undocumented extras)", async () => {
    await versionCommand.parseAsync(["--json"], { from: "user" });

    const raw = writtenChunks.join("").trim();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(parsed).sort()).toStrictEqual([
      "arch",
      "auditKeySource",
      "cli",
      "node",
      "platform",
      "region",
    ]);
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

  it("region field is 'unset' when AWS_REGION is absent (PR-030)", async () => {
    const original = process.env["AWS_REGION"];
    delete process.env["AWS_REGION"];
    try {
      await versionCommand.parseAsync(["--json"], { from: "user" });
      const raw = writtenChunks.join("").trim();
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      expect(parsed["region"]).toBe("unset");
    } finally {
      if (original !== undefined) {
        process.env["AWS_REGION"] = original;
      }
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
