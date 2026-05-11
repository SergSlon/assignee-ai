/**
 * Tests for `installJsonStdoutSuppressor`.
 *
 * Coverage:
 *   - enabled=false → no-op stub; stdout unchanged; flushSuccess/flushError
 *     are callable without side-effects.
 *   - enabled=true → process.stdout.write is replaced while active.
 *   - enabled=true → stdout writes are suppressed (bytes discarded).
 *   - flushSuccess restores stdout then emits valid JSON.
 *   - flushError restores stdout then emits the error envelope.
 *   - restore() is idempotent (safe to call multiple times).
 *   - detail field is passed through to flushError when provided.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { installJsonStdoutSuppressor } from "../json-stdout-suppressor.js";

// Real-data fixture types matching the command envelopes.
interface TestEnvelope {
  ok: true;
  operation: string;
  runId?: string;
}

describe("installJsonStdoutSuppressor", () => {
  let originalWrite: typeof process.stdout.write;
  let capturedOutput: string[];

  beforeEach(() => {
    capturedOutput = [];
    originalWrite = process.stdout.write.bind(process.stdout);
    // Redirect real stdout to our capture buffer so we don't pollute test output.
    process.stdout.write = ((
      chunk: string | Uint8Array,
      ...rest: unknown[]
    ): boolean => {
      capturedOutput.push(
        typeof chunk === "string"
          ? chunk
          : Buffer.from(chunk).toString("utf-8"),
      );
      const cb = rest.find((r) => typeof r === "function") as
        | ((err?: Error | null) => void)
        | undefined;
      if (cb) cb();
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
  });

  describe("enabled=false (no-op stub)", () => {
    it("does not replace process.stdout.write", () => {
      const writeBefore = process.stdout.write;
      const handle = installJsonStdoutSuppressor<TestEnvelope>(false);
      expect(process.stdout.write).toBe(writeBefore);
      handle.restore();
    });

    it("flushSuccess is callable without emitting output", () => {
      const handle = installJsonStdoutSuppressor<TestEnvelope>(false);
      handle.flushSuccess({ ok: true, operation: "apply" });
      expect(capturedOutput).toHaveLength(0);
    });

    it("flushError is callable without emitting output", () => {
      const handle = installJsonStdoutSuppressor<TestEnvelope>(false);
      handle.flushError("SOME_ERROR", "something went wrong", "try this");
      expect(capturedOutput).toHaveLength(0);
    });

    it("restore is callable without side-effects", () => {
      const writeBefore = process.stdout.write;
      const handle = installJsonStdoutSuppressor<TestEnvelope>(false);
      handle.restore();
      expect(process.stdout.write).toBe(writeBefore);
    });
  });

  describe("enabled=true", () => {
    it("replaces process.stdout.write while active", () => {
      const writeBefore = process.stdout.write;
      const handle = installJsonStdoutSuppressor<TestEnvelope>(true);
      expect(process.stdout.write).not.toBe(writeBefore);
      handle.restore();
    });

    it("suppresses stdout writes (bytes are discarded while active)", () => {
      const handle = installJsonStdoutSuppressor<TestEnvelope>(true);
      // Any write while the suppressor is active should not land in capturedOutput.
      // (Our beforeEach replaced the originalWrite; the suppressor captured that
      // and replaces it with a discard function — so capturedOutput stays empty.)
      process.stdout.write("should be discarded\n");
      handle.restore();
      expect(capturedOutput).toHaveLength(0);
    });

    it("flushSuccess restores stdout and emits valid indented JSON", () => {
      const handle = installJsonStdoutSuppressor<TestEnvelope>(true);
      const envelope: TestEnvelope = {
        ok: true,
        operation: "apply",
        runId: "run-abc-123",
      };
      handle.flushSuccess(envelope);

      // After flush, stdout should be restored.
      expect(capturedOutput).toHaveLength(1);
      const parsed = JSON.parse(capturedOutput[0]!) as TestEnvelope;
      expect(parsed.ok).toBe(true);
      expect(parsed.operation).toBe("apply");
      expect(parsed.runId).toBe("run-abc-123");
    });

    it("flushError restores stdout and emits structured error envelope", () => {
      const handle = installJsonStdoutSuppressor<TestEnvelope>(true);
      handle.flushError("DESTROY_ERROR", "Key not found", "Check the key ARN");

      expect(capturedOutput).toHaveLength(1);
      const parsed = JSON.parse(capturedOutput[0]!) as {
        ok: boolean;
        error: { code: string; message: string; hint?: string };
      };
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe("DESTROY_ERROR");
      expect(parsed.error.message).toBe("Key not found");
      expect(parsed.error.hint).toBe("Check the key ARN");
    });

    it("flushError passes detail field through when provided", () => {
      const handle = installJsonStdoutSuppressor<TestEnvelope>(true);
      handle.flushError("BP_BLOCKED", "Blocked by policy", undefined, {
        practiceIds: ["BP-IGW-001"],
      });

      expect(capturedOutput).toHaveLength(1);
      const parsed = JSON.parse(capturedOutput[0]!) as {
        ok: boolean;
        error: { code: string; detail?: { practiceIds?: string[] } };
      };
      expect(parsed.ok).toBe(false);
      expect(parsed.error.code).toBe("BP_BLOCKED");
      expect(parsed.error.detail?.practiceIds).toEqual(["BP-IGW-001"]);
    });

    it("restore() is idempotent — calling twice does not throw or double-restore", () => {
      const handle = installJsonStdoutSuppressor<TestEnvelope>(true);
      handle.restore();
      handle.restore(); // second call must be a no-op
      // Write after restore should land in capturedOutput.
      process.stdout.write("after restore\n");
      expect(capturedOutput).toHaveLength(1);
      expect(capturedOutput[0]).toBe("after restore\n");
    });

    it("flushSuccess is idempotent after restore", () => {
      const handle = installJsonStdoutSuppressor<TestEnvelope>(true);
      handle.flushSuccess({ ok: true, operation: "destroy" });
      // A second flushSuccess call after restore should still emit (no crash).
      handle.flushSuccess({ ok: true, operation: "destroy-2" });
      // Both should produce output.
      expect(capturedOutput.length).toBeGreaterThanOrEqual(2);
    });
  });
});
