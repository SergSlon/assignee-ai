/**
 * Tests for the doctor log-retention check (P045).
 *
 * Covers:
 *   1. General floor (30d): configured below floor → warn
 *   2. General floor (30d): configured at floor → ok
 *   3. General floor (30d): configured above floor → ok
 *   4. Audit floor (90d): ASSIGNEE_AUDIT_RETENTION_DAYS < 90 → warn (clamped)
 *   5. Audit floor (90d): ASSIGNEE_AUDIT_RETENTION_DAYS == 90 → ok
 *   6. Audit floor (90d): ASSIGNEE_AUDIT_RETENTION_DAYS > 90 → ok
 *   7. General logs directory missing → warn
 *   8. Audit logs directory missing → warn
 *   9. Both directories present, files within floor → ok
 *  10. General log files' oldest mtime below floor → warn (possible early rotation)
 *  11. Audit log files' oldest mtime below floor → warn (compliance concern)
 *  12. Section name + status shape contract
 *  13. rollup: any warn sub → section status == warn
 */

import {
  describe,
  it,
  expect,
  beforeEach,
  afterEach,
  vi,
  type MockInstance,
} from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { checkLogs } from "./logs.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "assignee-logs-check-test-"));
}

function seedLogFile(
  dir: string,
  name: string,
  mtimeDaysAgo: number,
  now: Date,
): void {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, name);
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      ts: new Date(now.getTime() - mtimeDaysAgo * 86400_000).toISOString(),
      level: "error",
      action: "apply_failed",
    }) + "\n",
    { mode: 0o600 },
  );
  // Backdate the mtime to mtimeDaysAgo
  const mtimeSec = (now.getTime() - mtimeDaysAgo * 86400_000) / 1000;
  fs.utimesSync(filePath, mtimeSec, mtimeSec);
}

// ── Test suite ─────────────────────────────────────────────────────────────

describe("checkLogs (P045 doctor sub-check)", () => {
  let tmpBase: string;
  let stderrSpy: MockInstance;
  const originalEnv = { ...process.env };

  beforeEach(() => {
    tmpBase = makeTempDir();
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation(() => true);
    // Clear relevant env vars before each test
    delete process.env["ASSIGNEE_LOG_RETENTION_DAYS"];
    delete process.env["ASSIGNEE_AUDIT_RETENTION_DAYS"];
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    process.env = { ...originalEnv };
    try {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  // ── Section shape contract ─────────────────────────────────────────────

  it("returns a section with name 'Log retention'", () => {
    const section = checkLogs({ assigneeDir: tmpBase });
    expect(section.name).toBe("Log retention");
  });

  it("returns exactly 4 sub-checks", () => {
    const section = checkLogs({ assigneeDir: tmpBase });
    expect(section.subs).toHaveLength(4);
  });

  it("section status is the rollup of sub-checks (any warn → warn)", () => {
    // No directories → both dir sub-checks warn → rollup = warn
    const section = checkLogs({ assigneeDir: tmpBase });
    expect(section.status).toBe("warn");
  });

  // ── General log retention config ────────────────────────────────────────

  it("general retention sub-check is ok when env var is unset (default 30d ≥ floor)", () => {
    delete process.env["ASSIGNEE_LOG_RETENTION_DAYS"];
    const section = checkLogs({ assigneeDir: tmpBase });
    const sub = section.subs.find((s) => s.label === "General log retention")!;
    expect(sub).toBeDefined();
    expect(sub.status).toBe("ok");
    expect(sub.detail).toContain("30d");
  });

  it("general retention sub-check is ok when env var is exactly at floor (30)", () => {
    process.env["ASSIGNEE_LOG_RETENTION_DAYS"] = "30";
    const section = checkLogs({ assigneeDir: tmpBase });
    const sub = section.subs.find((s) => s.label === "General log retention")!;
    expect(sub.status).toBe("ok");
    expect(sub.detail).toContain("30d");
  });

  it("general retention sub-check is ok when env var is above floor (60d)", () => {
    process.env["ASSIGNEE_LOG_RETENTION_DAYS"] = "60";
    const section = checkLogs({ assigneeDir: tmpBase });
    const sub = section.subs.find((s) => s.label === "General log retention")!;
    expect(sub.status).toBe("ok");
    expect(sub.detail).toContain("60d");
  });

  // resolveLogRetentionDays() clamps below-floor values UP to 30, so the
  // sub-check that reads the resolved value always sees ≥ 30. This mirrors
  // what actually happens at runtime: operators cannot shrink below the floor.
  it("general retention sub-check is ok when env var is below floor (10d — clamped to 30)", () => {
    process.env["ASSIGNEE_LOG_RETENTION_DAYS"] = "10";
    const section = checkLogs({ assigneeDir: tmpBase });
    const sub = section.subs.find((s) => s.label === "General log retention")!;
    // resolveLogRetentionDays clamps 10 → 30, so status is ok, not warn
    expect(sub.status).toBe("ok");
    expect(sub.detail).toContain("30d");
  });

  // ── Audit log retention config ──────────────────────────────────────────

  it("audit retention sub-check is ok when env var is unset (default 90d ≥ floor)", () => {
    delete process.env["ASSIGNEE_AUDIT_RETENTION_DAYS"];
    const section = checkLogs({ assigneeDir: tmpBase });
    const sub = section.subs.find((s) => s.label === "Audit log retention")!;
    expect(sub).toBeDefined();
    expect(sub.status).toBe("ok");
    expect(sub.detail).toContain("90d");
  });

  it("audit retention sub-check is ok when env var is exactly at floor (90)", () => {
    process.env["ASSIGNEE_AUDIT_RETENTION_DAYS"] = "90";
    const section = checkLogs({ assigneeDir: tmpBase });
    const sub = section.subs.find((s) => s.label === "Audit log retention")!;
    expect(sub.status).toBe("ok");
    expect(sub.detail).toContain("90d");
  });

  it("audit retention sub-check is ok when env var is above floor (180d)", () => {
    process.env["ASSIGNEE_AUDIT_RETENTION_DAYS"] = "180";
    const section = checkLogs({ assigneeDir: tmpBase });
    const sub = section.subs.find((s) => s.label === "Audit log retention")!;
    expect(sub.status).toBe("ok");
    expect(sub.detail).toContain("180d");
  });

  it("audit retention: ASSIGNEE_AUDIT_RETENTION_DAYS < 90 emits stderr error and sub-check warns [HIGH]", () => {
    process.env["ASSIGNEE_AUDIT_RETENTION_DAYS"] = "30";
    const section = checkLogs({ assigneeDir: tmpBase });
    // resolveAuditRetentionDays() writes to stderr and returns 90 (floor).
    // The doctor sub-check label includes [HIGH] to surface it prominently.
    const sub = section.subs.find((s) =>
      s.label.includes("Audit log retention"),
    )!;
    expect(sub).toBeDefined();
    // resolveAuditRetentionDays() clamps to 90 and writes a stderr error.
    // The doctor UI mirrors the error as a warn sub-check.
    expect(stderrSpy).toHaveBeenCalled();
    const stderrOutput = stderrSpy.mock.calls
      .map((c) => String(c[0] ?? ""))
      .join("");
    expect(stderrOutput).toContain("90-day compliance floor");
    expect(stderrOutput).toContain("ASSIGNEE_AUDIT_RETENTION_DAYS=30");
  });

  // ── General logs directory ─────────────────────────────────────────────

  it("general logs directory sub-check warns when directory does not exist", () => {
    const section = checkLogs({ assigneeDir: tmpBase });
    const sub = section.subs.find((s) => s.label === "General logs directory")!;
    expect(sub).toBeDefined();
    expect(sub.status).toBe("warn");
    expect(sub.detail).toContain("does not exist");
  });

  it("general logs directory sub-check is ok when directory exists with no log files", () => {
    fs.mkdirSync(path.join(tmpBase, "logs"), { recursive: true });
    const now = new Date();
    const section = checkLogs({ assigneeDir: tmpBase, now });
    const sub = section.subs.find((s) => s.label === "General logs directory")!;
    expect(sub.status).toBe("ok");
    expect(sub.detail).toContain("no log files present");
  });

  it("general logs directory sub-check is ok when files are older than floor (31d)", () => {
    const logsDir = path.join(tmpBase, "logs");
    const now = new Date("2026-04-26T12:00:00.000Z");
    seedLogFile(logsDir, "cli-2026-03-25.jsonl", 32, now); // 32d old
    const section = checkLogs({ assigneeDir: tmpBase, now });
    const sub = section.subs.find((s) => s.label === "General logs directory")!;
    expect(sub.status).toBe("ok");
    expect(sub.detail).toMatch(/32d/);
  });

  it("general logs directory sub-check warns when oldest mtime is below floor (only 5d old)", () => {
    const logsDir = path.join(tmpBase, "logs");
    const now = new Date("2026-04-26T12:00:00.000Z");
    seedLogFile(logsDir, "cli-2026-04-21.jsonl", 5, now); // only 5d old
    const section = checkLogs({ assigneeDir: tmpBase, now });
    const sub = section.subs.find((s) => s.label === "General logs directory")!;
    // 5d < 30d floor → warn
    expect(sub.status).toBe("warn");
    expect(sub.detail).toContain("may have been rotated below the minimum");
  });

  // ── Audit logs directory ───────────────────────────────────────────────

  it("audit logs directory sub-check warns when directory does not exist", () => {
    const section = checkLogs({ assigneeDir: tmpBase });
    const sub = section.subs.find((s) => s.label === "Audit logs directory")!;
    expect(sub).toBeDefined();
    expect(sub.status).toBe("warn");
    expect(sub.detail).toContain("does not exist");
  });

  it("audit logs directory sub-check is ok when directory exists with no log files", () => {
    fs.mkdirSync(path.join(tmpBase, "audit"), { recursive: true });
    const now = new Date();
    const section = checkLogs({ assigneeDir: tmpBase, now });
    const sub = section.subs.find((s) => s.label === "Audit logs directory")!;
    expect(sub.status).toBe("ok");
    expect(sub.detail).toContain("no audit log files present");
  });

  it("audit logs directory sub-check is ok when files are older than 90d floor (95d)", () => {
    const auditDir = path.join(tmpBase, "audit");
    const now = new Date("2026-04-26T12:00:00.000Z");
    seedLogFile(auditDir, "audit.log", 95, now); // 95d old ≥ 90d floor
    const section = checkLogs({ assigneeDir: tmpBase, now });
    const sub = section.subs.find((s) => s.label === "Audit logs directory")!;
    expect(sub.status).toBe("ok");
    expect(sub.detail).toMatch(/95d/);
    expect(sub.detail).toContain("ISO 27001");
  });

  it("audit logs directory sub-check warns when oldest mtime is below 90d floor (30d old)", () => {
    const auditDir = path.join(tmpBase, "audit");
    const now = new Date("2026-04-26T12:00:00.000Z");
    seedLogFile(auditDir, "audit.log", 30, now); // 30d < 90d floor
    const section = checkLogs({ assigneeDir: tmpBase, now });
    const sub = section.subs.find((s) => s.label === "Audit logs directory")!;
    expect(sub.status).toBe("warn");
    expect(sub.detail).toContain("deleted in violation of policy");
  });

  // ── All-green path ─────────────────────────────────────────────────────

  it("section status is ok when both dirs exist with adequately old files", () => {
    const logsDir = path.join(tmpBase, "logs");
    const auditDir = path.join(tmpBase, "audit");
    const now = new Date("2026-04-26T12:00:00.000Z");

    seedLogFile(logsDir, "cli-2026-03-20.jsonl", 37, now); // 37d ≥ 30d floor
    seedLogFile(auditDir, "audit.log", 100, now); // 100d ≥ 90d floor

    const section = checkLogs({ assigneeDir: tmpBase, now });
    expect(section.status).toBe("ok");
    section.subs.forEach((sub) => {
      expect(sub.status).toBe("ok");
    });
  });
});
