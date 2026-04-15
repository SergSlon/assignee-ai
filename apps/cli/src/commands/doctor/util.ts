/**
 * Cross-check utilities: timeout wrapper, status rollup, formatting.
 *
 * Kept tiny and dependency-free so every check file can import without
 * pulling AWS-SDK or fs.
 */

import type { CheckStatus, DoctorSubCheck } from "./types.js";

/**
 * Best-effort wrapper that resolves a promise or rejects after `ms`.
 *
 * EX-7 regression fix: we MUST clear the underlying setTimeout handle
 * once the wrapped promise settles. Without this, the Node event loop
 * stays alive for the full `ms` window after every successful check,
 * making the whole `doctor` command block for ~ms × checks even when
 * every call was fast. The 5-second-per-check budget is still enforced —
 * we just don't hold the process hostage when the call was actually fast.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeoutPromise = new Promise<T>((_, reject) => {
      timeoutHandle = setTimeout(
        () => reject(new Error(`${label} timed out after ${ms}ms`)),
        ms,
      );
    });
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

/** Worst-of two statuses (fail > warn > ok). */
export function worse(a: CheckStatus, b: CheckStatus): CheckStatus {
  if (a === "fail" || b === "fail") return "fail";
  if (a === "warn" || b === "warn") return "warn";
  return "ok";
}

/** Roll up an array of sub-check statuses into a section status. */
export function rollup(subs: DoctorSubCheck[]): CheckStatus {
  return subs.reduce<CheckStatus>((acc, s) => worse(acc, s.status), "ok");
}

/** Mask an access key for display (show prefix only — never the secret). */
export function maskKey(key: string): string {
  if (key.length <= 8) return "****";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/** Pad a pin like "awslabs.aws-pricing-mcp-server@1.0.6" for column alignment. */
export function padPin(pin: string): string {
  return pin.padEnd(48, " ");
}
