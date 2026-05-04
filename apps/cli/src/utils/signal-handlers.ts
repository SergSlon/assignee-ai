/**
 * Graceful shutdown signal handlers (P2-R2-3).
 *
 * Extracted from apps/cli/src/index.ts (W14-S2) so that signal-handler
 * tests can import this module directly without instantiating the full
 * Commander program tree.
 *
 * The signal handler MUST:
 *   1. Stop any active clack spinner first — otherwise the cursor stays
 *      hidden on some terminals and the label line stays partially drawn.
 *      Also emit the DECTCEM "show cursor" sequence as belt-and-suspenders
 *      so a crashed spinner can never leave the terminal with a hidden
 *      caret.
 *   2. Print a visible "Cancelled." marker to stderr so the user sees
 *      that their Ctrl-C was honored (prior behavior dropped silently
 *      while MCP clients closed in background).
 *   3. Close MCP child processes so no orphans remain.
 *   4. Flush stderr (async writes from the structured logger) before
 *      exiting, otherwise the last log line is lost on fast-exit.
 *   5. Exit with the conventional 128 + signum code.
 *
 * Story 50-2: added SIGHUP (nohup / tmux detach / SSH disconnect) and
 * SIGBREAK (Windows Ctrl-Break) handlers so cloud VMs, background
 * workflows and Windows users all get the same graceful teardown as
 * SIGINT / SIGTERM. SIGBREAK is Node-on-Windows-specific and raises a
 * runtime error if registered on non-Windows, so we gate on platform.
 *
 * Re-entrancy: a second signal during teardown bypasses cleanup and hard
 * exits — a stuck MCP close must not trap the user.
 */

import { closeMcpClient } from "../services/mcp-client.js";
import { stopSpinner } from "./display.js";

let shuttingDown = false;
type ShutdownSignal = "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGBREAK";

/** Tracks bound handlers so the same function is never registered twice. */
const _installedHandlers = new Map<ShutdownSignal, () => Promise<void>>();

function installSignalHandler(signal: ShutdownSignal, code: number) {
  // Remove any previously installed handler for this signal so repeated
  // calls to installSignalHandlers() (e.g. across vitest tests) don't
  // accumulate listeners and trigger MaxListenersExceededWarning. (F001)
  const existing = _installedHandlers.get(signal);
  if (existing) {
    process.removeListener(signal, existing);
  }

  const handler = async () => {
    if (shuttingDown) {
      // Second signal during teardown — abandon cleanup.
      //
      // Epic 61-it1-01 (L3-003): emit a stderr marker before the hard
      // exit so operators see why their repeated Ctrl-C bypassed the
      // normal "Cancelled." handshake. Without this the process simply
      // vanishes, leaving users to wonder whether the second signal
      // was observed at all. `console.error` is sync on the stderr
      // stream so the message reliably lands before process.exit.
      console.error(
        "assignee: received repeated interrupt during shutdown; forcing exit.",
      );
      process.exit(code);
    }
    shuttingDown = true;
    try {
      stopSpinner();
    } catch {
      /* spinner may not exist — non-fatal */
    }
    // Belt-and-suspenders: restore the cursor in case a crashed spinner
    // left it hidden. DECTCEM "show cursor" — harmless if already shown.
    if (process.stderr.isTTY) {
      try {
        process.stderr.write("\x1b[?25h");
      } catch {
        /* terminal already closed — non-fatal */
      }
    }
    process.stderr.write(`\nCancelled (${signal}).\n`);
    try {
      await closeMcpClient();
    } catch {
      /* child processes may already be gone */
    }
    // Best-effort stderr flush so structured log lines are not dropped.
    await new Promise<void>((resolve) => {
      if (process.stderr.writableNeedDrain) {
        process.stderr.once("drain", () => resolve());
      } else {
        resolve();
      }
    });
    process.exit(code);
  };

  _installedHandlers.set(signal, handler);
  process.on(signal, handler);
}

/**
 * Register SIGINT / SIGTERM / SIGHUP (and SIGBREAK on Windows) handlers.
 * Call once at CLI startup after the Commander program is ready.
 */
export function installSignalHandlers(): void {
  // Reset re-entrancy guard each time handlers are installed (important
  // for test isolation — each test re-registers via a fresh module import).
  shuttingDown = false;
  installSignalHandler("SIGINT", 128 + 2); // 130
  installSignalHandler("SIGTERM", 128 + 15); // 143
  installSignalHandler("SIGHUP", 128 + 1); // 129
  // SIGBREAK is Windows-only (raised by Ctrl-Break). Installing the
  // handler on POSIX is a no-op in Node but we gate explicitly so the
  // intent is clear.
  if (process.platform === "win32") {
    installSignalHandler("SIGBREAK", 128 + 21); // 149 (Node's SIGBREAK signum)
  }
}
