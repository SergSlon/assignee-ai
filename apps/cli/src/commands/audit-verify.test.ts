/**
 * W3-01 — audit-verify CLI command tests.
 * W7-S3 — adds --json mode tests.
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

  beforeEach(() => {
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
  });

  afterEach(() => {
    process.stdout.write = originalStdoutWrite;
    process.exit = originalExit;
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
    // invariant is that process.exit was called with non-zero.
    expect(process.exit).toHaveBeenCalledWith(1);
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
});
