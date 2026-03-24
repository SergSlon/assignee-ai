import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  startTimer,
  endTimer,
  getTimings,
  formatTimings,
  formatSummary,
  withTiming,
  persistTimings,
  resetTimings,
} from "./timing.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

describe("timing", () => {
  beforeEach(() => {
    resetTimings();
  });

  describe("startTimer / endTimer", () => {
    it("returns a positive elapsed ms", () => {
      startTimer("test-phase");
      const elapsed = endTimer("test-phase");
      expect(elapsed).toBeGreaterThanOrEqual(0);
      expect(typeof elapsed).toBe("number");
    });

    it("throws when ending a timer that was never started", () => {
      expect(() => endTimer("nonexistent")).toThrow(
        'Timer "nonexistent" was never started',
      );
    });

    it("measures actual elapsed time", async () => {
      startTimer("delay");
      await new Promise((resolve) => setTimeout(resolve, 50));
      const elapsed = endTimer("delay");
      // Should be at least ~50ms (allow some slack for CI)
      expect(elapsed).toBeGreaterThanOrEqual(30);
    });
  });

  describe("getTimings", () => {
    it("returns all completed timers", () => {
      startTimer("a");
      endTimer("a");
      startTimer("b");
      endTimer("b");

      const timings = getTimings();
      expect(Object.keys(timings)).toEqual(["a", "b"]);
      expect(timings["a"]).toBeGreaterThanOrEqual(0);
      expect(timings["b"]).toBeGreaterThanOrEqual(0);
    });

    it("returns empty object when no timers recorded", () => {
      expect(getTimings()).toEqual({});
    });

    it("does not include pending (unfinished) timers", () => {
      startTimer("pending-only");
      expect(getTimings()).toEqual({});
    });
  });

  describe("formatTimings", () => {
    it("produces readable output with label and ms", () => {
      startTimer("credential-check");
      endTimer("credential-check");
      startTimer("mcp-startup");
      endTimer("mcp-startup");

      const output = formatTimings();
      expect(output).toContain("credential-check");
      expect(output).toContain("mcp-startup");
      expect(output).toContain("ms");
    });

    it("returns fallback message when no timings exist", () => {
      expect(formatTimings()).toBe("No timings recorded.");
    });
  });

  describe("formatSummary", () => {
    it("produces a one-line summary with total and phases", () => {
      startTimer("credential-check");
      endTimer("credential-check");
      startTimer("mcp-startup");
      endTimer("mcp-startup");
      startTimer("total");
      endTimer("total");

      const summary = formatSummary();
      expect(summary).toMatch(/^Run complete in [\d.]+s \(/);
      expect(summary).toContain("credential-check:");
      expect(summary).toContain("mcp-startup:");
    });
  });

  describe("withTiming", () => {
    it("times an async function and returns its result", async () => {
      const result = await withTiming("async-op", async () => {
        return 42;
      });

      expect(result).toBe(42);
      const timings = getTimings();
      expect(timings["async-op"]).toBeGreaterThanOrEqual(0);
    });

    it("records timing even when the function throws", async () => {
      await expect(
        withTiming("failing-op", async () => {
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");

      const timings = getTimings();
      expect(timings["failing-op"]).toBeGreaterThanOrEqual(0);
    });
  });

  describe("persistTimings", () => {
    let tmpDir: string;
    let telemetryDir: string;
    let telemetryFile: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "assignee-test-"));
      telemetryDir = path.join(tmpDir, ".assignee", "telemetry");
      telemetryFile = path.join(telemetryDir, "timing.json");
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("writes timing data to file", () => {
      startTimer("phase-a");
      endTimer("phase-a");

      persistTimings("run-001", tmpDir);

      const raw = fs.readFileSync(telemetryFile, "utf-8");
      const data = JSON.parse(raw) as Array<{
        runId: string;
        phases: Array<{ label: string; durationMs: number }>;
      }>;
      expect(data).toHaveLength(1);
      expect(data[0]!.runId).toBe("run-001");
      expect(data[0]!.phases[0]!.label).toBe("phase-a");
    });

    it("appends to existing data", () => {
      startTimer("x");
      endTimer("x");
      persistTimings("run-1", tmpDir);

      resetTimings();
      startTimer("y");
      endTimer("y");
      persistTimings("run-2", tmpDir);

      const data = JSON.parse(
        fs.readFileSync(telemetryFile, "utf-8"),
      ) as Array<{
        runId: string;
      }>;
      expect(data).toHaveLength(2);
      expect(data[0]!.runId).toBe("run-1");
      expect(data[1]!.runId).toBe("run-2");
    });

    it("caps entries at 100", () => {
      // Pre-fill with 99 entries
      fs.mkdirSync(telemetryDir, { recursive: true });
      const existing = Array.from({ length: 99 }, (_, i) => ({
        version: 1,
        runId: `old-${i}`,
        timestamp: new Date().toISOString(),
        phases: [],
      }));
      fs.writeFileSync(telemetryFile, JSON.stringify(existing), "utf-8");

      // Add two more (should cap at 100 total)
      startTimer("z");
      endTimer("z");
      persistTimings("new-1", tmpDir);

      resetTimings();
      startTimer("z2");
      endTimer("z2");
      persistTimings("new-2", tmpDir);

      const data = JSON.parse(
        fs.readFileSync(telemetryFile, "utf-8"),
      ) as Array<{
        runId: string;
      }>;
      expect(data).toHaveLength(100);
      // First entry should be old-1 (old-0 was evicted)
      expect(data[0]!.runId).toBe("old-1");
      // Last entry should be the newest
      expect(data[99]!.runId).toBe("new-2");
    });

    it("skips persistence when ASSIGNEE_NO_TELEMETRY=1", () => {
      process.env["ASSIGNEE_NO_TELEMETRY"] = "1";
      try {
        startTimer("skip-me");
        endTimer("skip-me");
        persistTimings("run-skip", tmpDir);

        expect(fs.existsSync(telemetryFile)).toBe(false);
      } finally {
        delete process.env["ASSIGNEE_NO_TELEMETRY"];
      }
    });

    it("still collects in-memory timings when telemetry is disabled", () => {
      process.env["ASSIGNEE_NO_TELEMETRY"] = "1";
      try {
        startTimer("in-memory");
        endTimer("in-memory");
        const timings = getTimings();
        expect(timings["in-memory"]).toBeGreaterThanOrEqual(0);
      } finally {
        delete process.env["ASSIGNEE_NO_TELEMETRY"];
      }
    });
  });
});
