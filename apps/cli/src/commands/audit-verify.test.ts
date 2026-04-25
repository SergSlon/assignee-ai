/**
 * W3-01 — audit-verify CLI command tests.
 */

import { describe, it, expect } from "vitest";
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
});
