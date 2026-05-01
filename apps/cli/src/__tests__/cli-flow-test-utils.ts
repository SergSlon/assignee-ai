/**
 * Shared stdout/stderr capture helpers for cli-flow-* test suites.
 *
 * Used by:
 *   - cli-flow-engine.test.ts
 *   - cli-flow-reconcile.test.ts
 *
 * Not exported from any public barrel — test-only module, relative import only.
 */

import { vi } from "vitest";

let stdoutWrites: string[] = [];
let stderrWrites: string[] = [];
const origStdoutWrite = process.stdout.write.bind(process.stdout);
const origStderrWrite = process.stderr.write.bind(process.stderr);

export function captureOutput(): void {
  stdoutWrites = [];
  stderrWrites = [];
  process.stdout.write = vi.fn((...args: unknown[]) => {
    const data = typeof args[0] === "string" ? args[0] : String(args[0]);
    stdoutWrites.push(data);
    return true;
  }) as typeof process.stdout.write;
  process.stderr.write = vi.fn((...args: unknown[]) => {
    const data = typeof args[0] === "string" ? args[0] : String(args[0]);
    stderrWrites.push(data);
    return true;
  }) as typeof process.stderr.write;
}

export function restoreOutput(): void {
  process.stdout.write = origStdoutWrite;
  process.stderr.write = origStderrWrite;
}

export function getStdout(): string {
  return stdoutWrites.join("");
}
