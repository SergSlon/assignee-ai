/**
 * Defect 5 (2026-05-09): tests for the shared `ensureAssigneeHomeDir`
 * helper that fixes the umask-leaks-into-`~/.assignee` bug.
 *
 * Coverage:
 *   - existing 0o755 dir → relocked to 0o700.
 *   - absent dir → created at 0o700.
 *   - already-0o700 dir → idempotent no-op.
 *   - chmodSync fails → structured stderr warning, no throw.
 *   - mkdirSync fails → structured stderr warning, no throw.
 *
 * All tests use a scoped tempdir so we never touch the user's real
 * `~/.assignee`.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ensureAssigneeHomeDir,
  type EnsureAssigneeHomeDirFs,
} from "./ensure-assignee-home-dir.js";

describe("ensureAssigneeHomeDir", () => {
  let tmpDir: string;
  let stderrChunks: string[];
  const originalWrite = process.stderr.write.bind(process.stderr);

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "ensure-assignee-home-test-"),
    );
    stderrChunks = [];
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrChunks.push(
        typeof chunk === "string"
          ? chunk
          : Buffer.from(chunk).toString("utf-8"),
      );
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stderr.write = originalWrite;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  it(
    "relocks an existing 0o755 directory to 0o700",
    { skip: process.platform === "win32" },
    () => {
      const target = path.join(tmpDir, "preexisting");
      fs.mkdirSync(target, { mode: 0o755 });
      // Sanity: the dir is 0o755 (umask-derived). On some shells the
      // umask leaves us at 0o775 etc.; explicit chmod settles it.
      fs.chmodSync(target, 0o755);
      expect(fs.statSync(target).mode & 0o777).toBe(0o755);

      ensureAssigneeHomeDir(target);

      expect(fs.statSync(target).mode & 0o777).toBe(0o700);
    },
  );

  it(
    "creates an absent directory at 0o700",
    { skip: process.platform === "win32" },
    () => {
      const target = path.join(tmpDir, "fresh");
      expect(fs.existsSync(target)).toBe(false);

      ensureAssigneeHomeDir(target);

      expect(fs.existsSync(target)).toBe(true);
      expect(fs.statSync(target).mode & 0o777).toBe(0o700);
    },
  );

  it(
    "is idempotent when called twice on an already-0o700 directory",
    { skip: process.platform === "win32" },
    () => {
      const target = path.join(tmpDir, "secure");
      fs.mkdirSync(target, { mode: 0o700 });
      fs.chmodSync(target, 0o700);

      ensureAssigneeHomeDir(target);
      ensureAssigneeHomeDir(target);

      expect(fs.statSync(target).mode & 0o777).toBe(0o700);
      // No warning fired on either call — idempotent calls are silent.
      const warnings = stderrChunks.filter((c) =>
        c.includes("assignee-home-dir"),
      );
      expect(warnings).toHaveLength(0);
    },
  );

  it("emits a structured warning (no throw) when chmodSync fails", () => {
    // Inject an fs mock whose chmodSync throws EPERM. mkdirSync passes
    // through to the real impl so the dir is created at 0o755 first.
    const target = path.join(tmpDir, "ro-target");
    fs.mkdirSync(target, { mode: 0o755 });

    const mockFs: EnsureAssigneeHomeDirFs = {
      mkdirSync: (dir, options) => {
        fs.mkdirSync(dir, options);
      },
      chmodSync: () => {
        throw Object.assign(new Error("EPERM: operation not permitted"), {
          code: "EPERM",
        });
      },
    };

    expect(() => ensureAssigneeHomeDir(target, mockFs)).not.toThrow();

    const warnings = stderrChunks.filter((c) =>
      c.includes("assignee-home-dir-chmod-failed"),
    );
    // On Windows the chmod path is skipped, so the warning never fires.
    if (process.platform !== "win32") {
      expect(warnings.length).toBeGreaterThanOrEqual(1);
      // Structured payload includes the dir + error fields.
      const parsed = JSON.parse(warnings[0]!) as {
        level: string;
        event: string;
        dir: string;
        error: string;
      };
      expect(parsed.level).toBe("warn");
      expect(parsed.event).toBe("assignee-home-dir-chmod-failed");
      expect(parsed.dir).toBe(target);
      expect(parsed.error).toContain("EPERM");
    }
  });

  it("emits a structured warning (no throw) when mkdirSync fails", () => {
    const target = path.join(tmpDir, "unmakeable");

    const mockFs: EnsureAssigneeHomeDirFs = {
      mkdirSync: () => {
        throw Object.assign(new Error("EACCES: permission denied"), {
          code: "EACCES",
        });
      },
      chmodSync: () => {
        // Should never be reached when mkdirSync throws.
        throw new Error("chmodSync should not be called when mkdirSync fails");
      },
    };

    expect(() => ensureAssigneeHomeDir(target, mockFs)).not.toThrow();

    const warnings = stderrChunks.filter((c) =>
      c.includes("assignee-home-dir-mkdir-failed"),
    );
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(warnings[0]!) as {
      level: string;
      event: string;
      dir: string;
      error: string;
    };
    expect(parsed.event).toBe("assignee-home-dir-mkdir-failed");
    expect(parsed.dir).toBe(target);
    expect(parsed.error).toContain("EACCES");
  });
});
