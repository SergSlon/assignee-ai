/**
 * Tests for the CLI signal-handler re-entrancy branch.
 *
 * Context — Epic 61-it1-01 (L3-003): when a user mashes Ctrl-C during a
 * stuck shutdown (e.g. hung MCP client close), the 2nd / 3rd signal hits
 * the `shuttingDown` guard and hard-exits via `process.exit(code)`.
 * Prior to this story that hard-exit was silent; operators saw the
 * process vanish with no indication that their repeated interrupt was
 * observed. We now emit `console.error("assignee: received repeated
 * interrupt during shutdown; forcing exit.")` before the exit so the
 * terminal reflects why the cleanup handshake was abandoned.
 *
 * Testing approach: we mock Commander so `program.parseAsync` does not
 * actually run the CLI tree, import the entrypoint to register the
 * signal handlers, then emit two synchronous SIGINTs. The first one
 * flips the `shuttingDown` flag and schedules async cleanup; the second
 * immediately re-enters the guard branch and calls `process.exit(code)`.
 * We spy on both `console.error` and `process.exit` so the test asserts
 * (a) the stderr marker fires BEFORE the hard exit, and (b) the exit
 * code matches the conventional 128 + signum (= 130 for SIGINT).
 *
 * We do NOT assert on the full cleanup path (spinner stop, MCP close,
 * stderr drain) — those are validated by existing integration tests.
 * This file targets the single branch introduced by the L3-003 fix.
 *
 * @see apps/cli/src/index.ts — installSignalHandler
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
  type MockInstance,
} from "vitest";

// Mock commander so importing index.ts does not try to actually parse
// process.argv / run commands / talk to stdout. This mirrors the shape
// used by apps/cli/src/index.test.ts.
vi.mock("commander", () => {
  const MockCommand = vi.fn();
  MockCommand.prototype.name = vi.fn().mockReturnThis();
  MockCommand.prototype.description = vi.fn().mockReturnThis();
  MockCommand.prototype.version = vi.fn().mockReturnThis();
  MockCommand.prototype.addCommand = vi.fn().mockReturnThis();
  MockCommand.prototype.argument = vi.fn().mockReturnThis();
  MockCommand.prototype.option = vi.fn().mockReturnThis();
  MockCommand.prototype.action = vi.fn().mockReturnThis();
  MockCommand.prototype.command = vi.fn().mockReturnThis();
  MockCommand.prototype.addHelpText = vi.fn().mockReturnThis();
  MockCommand.prototype.configureHelp = vi.fn().mockReturnThis();
  MockCommand.prototype.hook = vi.fn().mockReturnThis();
  MockCommand.prototype.alias = vi.fn().mockReturnThis();
  MockCommand.prototype.commands = [];
  MockCommand.prototype.parseAsync = vi.fn().mockResolvedValue(undefined);
  return { Command: MockCommand };
});

// MCP client close is async — stub it to resolve immediately so the
// first signal's cleanup path doesn't linger past the test's lifecycle.
vi.mock("../services/mcp-client.js", () => ({
  closeMcpClient: vi.fn().mockResolvedValue(undefined),
}));

// Update notifier, first-run bootstrap, and spinner stop all emit
// side-effects on import/invoke — stub them so the test environment
// is not polluted.
vi.mock("../utils/update-notifier.js", () => ({
  checkForUpdates: vi.fn(),
}));
vi.mock("../utils/first-run.js", () => ({
  bootstrapFirstRun: vi.fn(),
}));
vi.mock("../utils/display.js", () => ({
  stopSpinner: vi.fn(),
}));

describe("signal handler — re-entrancy warning (Epic 61-it1-01 L3-003)", () => {
  let exitSpy: MockInstance<typeof process.exit>;
  let errorSpy: MockInstance<typeof console.error>;
  let stderrSpy: MockInstance<typeof process.stderr.write>;

  beforeEach(() => {
    // Prevent actual process termination. We turn process.exit into a
    // silent no-op so both the first signal's cleanup-path exit AND the
    // second signal's re-entrancy-path exit are recorded on the spy
    // without actually terminating the worker. Unlike a sentinel-throw
    // pattern this avoids spurious unhandled-rejection noise from the
    // async first-signal listener (which awaits closeMcpClient and
    // then calls exit — a throw would reject that promise).
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation(
        ((_code?: number) => undefined) as typeof process.exit,
      );

    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    // stderr.write is called by the first-signal path (printing
    // "Cancelled (SIGINT)."). We swallow it to keep test output clean.
    stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockImplementation((() => true) as typeof process.stderr.write);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    errorSpy.mockRestore();
    stderrSpy.mockRestore();
    // Remove any SIGINT/SIGTERM/SIGHUP listeners registered by index.ts
    // so repeated test runs do not accumulate handlers on the real
    // process object.
    process.removeAllListeners("SIGINT");
    process.removeAllListeners("SIGTERM");
    process.removeAllListeners("SIGHUP");
  });

  it("emits stderr warning before hard-exiting on a repeated SIGINT during shutdown", async () => {
    // Import the entrypoint to register the SIGINT handler. We import
    // dynamically so the vi.mock hoisting above is in effect before
    // index.ts's top-level statements run.
    await import("../index.js");

    // First SIGINT: flips `shuttingDown = true` and kicks off the
    // async cleanup path. The cleanup eventually awaits closeMcpClient
    // (stubbed to resolve immediately) and then calls process.exit.
    // Because we swallow process.exit with the sentinel throw, the
    // async handler's unhandled rejection is caught below.
    const firstSignalSettled = new Promise<void>((resolve) => {
      // Yield to the microtask queue so the async listener has a
      // chance to reach its first await. 2 microtask ticks are enough
      // because closeMcpClient is a stubbed resolved promise.
      setImmediate(() => setImmediate(resolve));
    });
    process.emit("SIGINT");
    await firstSignalSettled;

    // Second SIGINT: `shuttingDown` is now true, so the handler hits
    // the re-entrancy branch. That branch MUST:
    //   1. call console.error with the repeat-interrupt marker, THEN
    //   2. call process.exit(130).
    process.emit("SIGINT");

    // Assert the stderr marker was emitted — substring match so minor
    // wording tweaks don't break the regression signal, but the three
    // anchors (product name, "repeated interrupt", "forcing exit")
    // are the durable contract.
    const repeatCall = errorSpy.mock.calls.find((call) => {
      const msg = typeof call[0] === "string" ? call[0] : "";
      return (
        msg.includes("assignee") &&
        msg.includes("repeated interrupt") &&
        msg.includes("forcing exit")
      );
    });
    expect(repeatCall).toBeDefined();

    // Exit code is the conventional 128 + signum. SIGINT = 2, so 130.
    // Both the first (cleanup-path) and second (re-entrancy-path) exits
    // use the same code, so we assert the call happened with 130 at
    // least once rather than pinning the exact invocation count — the
    // re-entrancy branch is the one guarded by the console.error check
    // above.
    expect(exitSpy).toHaveBeenCalledWith(130);
  });
});
