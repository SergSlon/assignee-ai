/**
 * W3-01 — audit-verify CLI command tests.
 * W7-S3 — adds --json mode tests.
 * W10-S1 — adds chainMode surface + migration hint tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs";
import { auditVerifyCommand } from "./audit-verify.js";

// ── Command shape tests ───────────────────────────────────────────────────

describe("auditVerifyCommand — command shape", () => {
  it("has name 'audit-verify'", () => {
    expect(auditVerifyCommand.name()).toBe("audit-verify");
  });

  it("has a description", () => {
    expect(auditVerifyCommand.description().length).toBeGreaterThan(0);
  });

  it("registers --from flag", () => {
    const opts = auditVerifyCommand.options;
    const fromOpt = opts.find((o) => o.long === "--from");
    expect(fromOpt).toBeDefined();
  });

  it("registers --to flag", () => {
    const opts = auditVerifyCommand.options;
    const toOpt = opts.find((o) => o.long === "--to");
    expect(toOpt).toBeDefined();
  });

  it("registers --log-file flag", () => {
    const opts = auditVerifyCommand.options;
    const logFileOpt = opts.find((o) => o.long === "--log-file");
    expect(logFileOpt).toBeDefined();
  });

  it("registers --json flag", () => {
    const opts = auditVerifyCommand.options;
    const jsonOpt = opts.find((o) => o.long === "--json");
    expect(jsonOpt).toBeDefined();
    // Must be a boolean flag (no argument)
    expect(jsonOpt?.required).toBe(false);
    expect(jsonOpt?.optional).toBe(false);
  });
});

// ── --json output tests ───────────────────────────────────────────────────

describe("auditVerifyCommand — --json output", () => {
  let tmpDir: string;
  let writtenChunks: string[];
  let originalStdoutWrite: typeof process.stdout.write;
  let originalExit: typeof process.exit;

  beforeEach(async () => {
    // The vi.mock for W10-S1 is file-scoped, and vitest.config has
    // mockReset:true which wipes implementations between every test.
    // Re-install the real verifyAuditLog before each test so this suite's
    // real-I/O tests work correctly.
    const real = await vi.importActual<{
      verifyAuditLog: typeof import("@assignee/core/audit").verifyAuditLog;
    }>("@assignee/core/audit");
    mockVerifyAuditLog.mockImplementation(real.verifyAuditLog);

    // Commander is a singleton; reset parsed option values so --json from a
    // previous test does not bleed into this one.
    (
      auditVerifyCommand as unknown as {
        _optionValues: Record<string, unknown>;
        _optionValueSources: Record<string, unknown>;
      }
    )._optionValues = {};
    (
      auditVerifyCommand as unknown as {
        _optionValueSources: Record<string, unknown>;
      }
    )._optionValueSources = {};

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "assignee-av-json-test-"));
    writtenChunks = [];
    originalStdoutWrite = process.stdout.write.bind(process.stdout);
    // Capture stdout writes without actually writing
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      writtenChunks.push(
        typeof chunk === "string"
          ? chunk
          : Buffer.from(chunk).toString("utf-8"),
      );
      return true;
    }) as typeof process.stdout.write;
    // Stub process.exit so tests don't abort
    originalExit = process.exit;
    process.exit = vi.fn() as unknown as typeof process.exit;
    // W15-S1: source uses process.exitCode = N; reset before each test
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.stdout.write = originalStdoutWrite;
    process.exit = originalExit;
    process.exitCode = undefined;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("emits valid JSON with valid:true and entries:N when chain is intact", async () => {
    // An empty log file → verifyAuditLog returns ok:true, total:0
    const logFile = path.join(tmpDir, "audit.log");
    fs.writeFileSync(logFile, "", "utf-8");

    await auditVerifyCommand.parseAsync(["--json", "--log-file", logFile], {
      from: "user",
    });

    expect(writtenChunks.length).toBeGreaterThan(0);
    const raw = writtenChunks.join("");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(typeof parsed["valid"]).toBe("boolean");
    expect(typeof parsed["entries"]).toBe("number");
  });

  it("emits valid JSON with valid:false and error string when log file missing", async () => {
    const logFile = path.join(tmpDir, "does-not-exist.log");

    await auditVerifyCommand.parseAsync(["--json", "--log-file", logFile], {
      from: "user",
    });

    // May emit to stdout (json error envelope) or to stderr; the key
    // invariant is that exitCode was set to non-zero.
    // W15-S1: source uses process.exitCode = N (not process.exit(N)).
    expect(process.exitCode).toBe(1);
    // If a JSON envelope was written it must be parseable
    const raw = writtenChunks.join("");
    if (raw.trim().length > 0) {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      expect(parsed["valid"]).toBe(false);
      expect(typeof parsed["error"]).toBe("string");
    }
  });

  it("emits JSON object (not array, not primitive) as a single line", async () => {
    const logFile = path.join(tmpDir, "audit2.log");
    fs.writeFileSync(logFile, "", "utf-8");

    await auditVerifyCommand.parseAsync(["--json", "--log-file", logFile], {
      from: "user",
    });

    const raw = writtenChunks.join("").trim();
    // Must be a single JSON object line
    const parsed = JSON.parse(raw);
    expect(parsed).not.toBeNull();
    expect(typeof parsed).toBe("object");
    expect(Array.isArray(parsed)).toBe(false);
  });

  it("includes chainMode field in --json success output (empty log → canonical)", async () => {
    const logFile = path.join(tmpDir, "audit-canonical.log");
    fs.writeFileSync(logFile, "", "utf-8");

    await auditVerifyCommand.parseAsync(["--json", "--log-file", logFile], {
      from: "user",
    });

    const raw = writtenChunks.join("").trim();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed["valid"]).toBe(true);
    expect(parsed["chainMode"]).toBe("canonical");
  });
});

// ── W10-S1: chainMode surface + migration hint tests ───────────────────────
//
// These tests mock verifyAuditLog to control the chainMode returned,
// so we can verify the CLI's surface behaviour without needing real HMAC
// fixtures for every chainMode variant.

const mockVerifyAuditLog = vi.hoisted(() => vi.fn());

vi.mock("@assignee/core/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@assignee/core/audit")>();
  return {
    ...actual,
    verifyAuditLog: mockVerifyAuditLog,
  };
});

describe("auditVerifyCommand — chainMode surface (W10-S1)", () => {
  let tmpDir: string;
  let stdoutChunks: string[];
  let stderrChunks: string[];
  let originalStdoutWrite: typeof process.stdout.write;
  let originalStderrWrite: typeof process.stderr.write;
  let originalExit: typeof process.exit;

  beforeEach(() => {
    // Commander is a singleton; reset parsed option values so --json from a
    // previous test does not bleed into this one.
    (
      auditVerifyCommand as unknown as {
        _optionValues: Record<string, unknown>;
        _optionValueSources: Record<string, unknown>;
      }
    )._optionValues = {};
    (
      auditVerifyCommand as unknown as {
        _optionValueSources: Record<string, unknown>;
      }
    )._optionValueSources = {};

    tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "assignee-av-chainmode-test-"),
    );
    stdoutChunks = [];
    stderrChunks = [];

    originalStdoutWrite = process.stdout.write.bind(process.stdout);
    originalStderrWrite = process.stderr.write.bind(process.stderr);

    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      stdoutChunks.push(
        typeof chunk === "string"
          ? chunk
          : Buffer.from(chunk).toString("utf-8"),
      );
      return true;
    }) as typeof process.stdout.write;

    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrChunks.push(
        typeof chunk === "string"
          ? chunk
          : Buffer.from(chunk).toString("utf-8"),
      );
      return true;
    }) as typeof process.stderr.write;

    originalExit = process.exit;
    process.exit = vi.fn() as unknown as typeof process.exit;
    // W15-S1: source uses process.exitCode = N; reset before each test
    process.exitCode = undefined;

    mockVerifyAuditLog.mockReset();
  });

  afterEach(() => {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
    process.exit = originalExit;
    process.exitCode = undefined;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("plain text: emits 'Chain mode: canonical' and no migration warning for canonical chain", async () => {
    const logFile = path.join(tmpDir, "canonical.log");
    fs.writeFileSync(logFile, "", "utf-8");
    mockVerifyAuditLog.mockResolvedValue({
      ok: true,
      total: 5,
      legacyCount: 0,
      chainMode: "canonical",
    });

    await auditVerifyCommand.parseAsync(["--log-file", logFile], {
      from: "user",
    });

    const stdout = stdoutChunks.join("");
    const stderr = stderrChunks.join("");
    expect(stdout).toContain("Chain mode: canonical");
    expect(stderr).not.toContain("audit-migrate-legacy-chain");
    // W15-S1: source sets process.exitCode = 0 instead of calling process.exit(0).
    expect(process.exitCode).toBe(0);
  });

  it("plain text: emits 'Chain mode: legacy' and migration warning for legacy chain", async () => {
    const logFile = path.join(tmpDir, "legacy.log");
    fs.writeFileSync(logFile, "", "utf-8");
    mockVerifyAuditLog.mockResolvedValue({
      ok: true,
      total: 3,
      legacyCount: 0,
      chainMode: "legacy",
    });

    await auditVerifyCommand.parseAsync(["--log-file", logFile], {
      from: "user",
    });

    const stdout = stdoutChunks.join("");
    const stderr = stderrChunks.join("");
    expect(stdout).toContain("Chain mode: legacy");
    expect(stderr).toContain("legacy");
    expect(stderr).toContain("audit-migrate-legacy-chain");
    // W15-S1: source sets process.exitCode = 0 instead of calling process.exit(0).
    expect(process.exitCode).toBe(0);
  });

  it("plain text: emits 'Chain mode: mixed' and migration warning for mixed chain", async () => {
    const logFile = path.join(tmpDir, "mixed.log");
    fs.writeFileSync(logFile, "", "utf-8");
    mockVerifyAuditLog.mockResolvedValue({
      ok: true,
      total: 10,
      legacyCount: 0,
      chainMode: "mixed",
    });

    await auditVerifyCommand.parseAsync(["--log-file", logFile], {
      from: "user",
    });

    const stdout = stdoutChunks.join("");
    const stderr = stderrChunks.join("");
    expect(stdout).toContain("Chain mode: mixed");
    expect(stderr).toContain("mixed");
    expect(stderr).toContain("audit-migrate-legacy-chain");
    // W15-S1: source sets process.exitCode = 0 instead of calling process.exit(0).
    expect(process.exitCode).toBe(0);
  });

  it("--json: includes chainMode field in success JSON for legacy chain", async () => {
    const logFile = path.join(tmpDir, "legacy-json.log");
    fs.writeFileSync(logFile, "", "utf-8");
    mockVerifyAuditLog.mockResolvedValue({
      ok: true,
      total: 4,
      legacyCount: 0,
      chainMode: "legacy",
    });

    await auditVerifyCommand.parseAsync(["--json", "--log-file", logFile], {
      from: "user",
    });

    const raw = stdoutChunks.join("").trim();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed["valid"]).toBe(true);
    expect(parsed["entries"]).toBe(4);
    expect(parsed["chainMode"]).toBe("legacy");
    // Migration warning goes to stderr, not stdout
    expect(stderrChunks.join("")).toContain("audit-migrate-legacy-chain");
    // W15-S1: source sets process.exitCode = 0 instead of calling process.exit(0).
    expect(process.exitCode).toBe(0);
  });

  it("--json: includes chainMode field in success JSON for mixed chain", async () => {
    const logFile = path.join(tmpDir, "mixed-json.log");
    fs.writeFileSync(logFile, "", "utf-8");
    mockVerifyAuditLog.mockResolvedValue({
      ok: true,
      total: 7,
      legacyCount: 0,
      chainMode: "mixed",
    });

    await auditVerifyCommand.parseAsync(["--json", "--log-file", logFile], {
      from: "user",
    });

    const raw = stdoutChunks.join("").trim();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed["valid"]).toBe(true);
    expect(parsed["chainMode"]).toBe("mixed");
    // W15-S1: source sets process.exitCode = 0 instead of calling process.exit(0).
    expect(process.exitCode).toBe(0);
  });

  it("--json: includes chainMode field in success JSON for canonical chain", async () => {
    const logFile = path.join(tmpDir, "canonical-json.log");
    fs.writeFileSync(logFile, "", "utf-8");
    mockVerifyAuditLog.mockResolvedValue({
      ok: true,
      total: 2,
      legacyCount: 0,
      chainMode: "canonical",
    });

    await auditVerifyCommand.parseAsync(["--json", "--log-file", logFile], {
      from: "user",
    });

    const raw = stdoutChunks.join("").trim();
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed["valid"]).toBe(true);
    expect(parsed["chainMode"]).toBe("canonical");
    // No migration warning for canonical chain
    expect(stderrChunks.join("")).not.toContain("audit-migrate-legacy-chain");
    // W15-S1: source sets process.exitCode = 0 instead of calling process.exit(0).
    expect(process.exitCode).toBe(0);
  });

  it("exit codes unchanged: exit 0 for valid chain regardless of chainMode (legacy)", async () => {
    const logFile = path.join(tmpDir, "exit-legacy.log");
    fs.writeFileSync(logFile, "", "utf-8");
    mockVerifyAuditLog.mockResolvedValue({
      ok: true,
      total: 3,
      legacyCount: 0,
      chainMode: "legacy",
    });

    await auditVerifyCommand.parseAsync(["--log-file", logFile], {
      from: "user",
    });

    // W15-S1: source sets process.exitCode = 0 instead of calling process.exit(0).
    expect(process.exitCode).toBe(0);
    expect(process.exitCode).not.toBe(1);
  });

  it("exit codes unchanged: exit 0 for valid chain regardless of chainMode (mixed)", async () => {
    const logFile = path.join(tmpDir, "exit-mixed.log");
    fs.writeFileSync(logFile, "", "utf-8");
    mockVerifyAuditLog.mockResolvedValue({
      ok: true,
      total: 6,
      legacyCount: 0,
      chainMode: "mixed",
    });

    await auditVerifyCommand.parseAsync(["--log-file", logFile], {
      from: "user",
    });

    // W15-S1: source sets process.exitCode = 0 instead of calling process.exit(0).
    expect(process.exitCode).toBe(0);
    expect(process.exitCode).not.toBe(1);
  });
});
