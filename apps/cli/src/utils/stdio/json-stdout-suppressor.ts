/**
 * Generic JSON-mode stdout suppressor.
 *
 * Shared by `apply`, `destroy`, and `reconcile` commands.  When JSON output
 * mode is active, all stdout writes produced by the inner action (spinner
 * frames, box renderers, human-readable tables) are silently discarded so
 * only a single structured envelope reaches the caller's pipe.
 *
 * On completion the caller invokes either `flushSuccess` or `flushError`;
 * both restore the original `process.stdout.write` before writing the
 * envelope, so the envelope itself is never swallowed.
 *
 * When `enabled=false` the returned handle is a no-op stub — callers can
 * always call `flushSuccess` / `flushError` / `restore` unconditionally
 * without an `if (jsonMode)` guard.
 *
 * @typeParam T  The success envelope type (e.g. `ApplySuccessEnvelope`).
 *               Using generics keeps the type-safe `envelope` parameter in
 *               `flushSuccess` while sharing the interception logic.
 */

import { serializeErrorEnvelope, type JsonErrorDetail } from "@assignee/core";
import { redactAccountIdIfDemoMode } from "../../commands/output-format.js";

export interface JsonStdoutSuppressorHandle<T> {
  /** Restore stdout and emit the success envelope as indented JSON. */
  flushSuccess: (envelope: T) => void;
  /**
   * Restore stdout and emit a structured error envelope.
   *
   * `detail` is optional — `destroy` and `reconcile` never pass it; only
   * `apply` uses the `detail` field for bp_blocked / apply_failed cases.
   */
  flushError: (
    code: string,
    message: string,
    hint?: string,
    detail?: JsonErrorDetail,
  ) => void;
  /** Restore stdout without emitting an envelope (called in finally blocks). */
  restore: () => void;
}

/**
 * Install a stdout suppressor for JSON output mode.
 *
 * @param enabled  When `false`, returns a no-op stub.  When `true`,
 *   replaces `process.stdout.write` with a function that silently
 *   discards all bytes (invoking the callback argument synchronously so
 *   callers that check the return value see a successful write).
 */
export function installJsonStdoutSuppressor<T>(
  enabled: boolean,
): JsonStdoutSuppressorHandle<T> {
  if (!enabled) {
    return {
      flushSuccess: () => {},
      flushError: () => {},
      restore: () => {},
    };
  }

  // Capture the original by reference (NOT `.bind(...)`) so restore()
  // puts back the exact function-identity the test harness may have
  // spied on.
  const originalWrite = process.stdout.write;

  // Suppress all stdout writes while JSON mode is active. Any byte
  // that would otherwise appear on stdout gets dropped; the inner
  // action's callers see a successful synchronous write. Stderr is
  // untouched so log events + human error blocks still render.
  process.stdout.write = ((
    _chunk: string | Uint8Array,
    ...rest: unknown[]
  ): boolean => {
    const cb = rest.find((r) => typeof r === "function") as
      | ((err?: Error | null) => void)
      | undefined;
    if (cb) cb();
    return true;
  }) as typeof process.stdout.write;

  let restored = false;
  const restore = (): void => {
    if (restored) return;
    process.stdout.write = originalWrite;
    restored = true;
  };

  return {
    flushSuccess: (envelope) => {
      restore();
      originalWrite.call(
        process.stdout,
        redactAccountIdIfDemoMode(JSON.stringify(envelope, null, 2) + "\n"),
      );
    },
    flushError: (code, message, hint, detail) => {
      restore();
      originalWrite.call(
        process.stdout,
        redactAccountIdIfDemoMode(
          serializeErrorEnvelope(code, message, hint, detail),
        ),
      );
    },
    restore,
  };
}
