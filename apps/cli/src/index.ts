#!/usr/bin/env node

// Load .env from repo root before any other imports read process.env.
// Silent no-op in CI where env vars are injected directly.
try {
  process.loadEnvFile();
} catch {
  // .env not present — rely on shell environment
}

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Command } from "commander";
import chalk from "chalk";
import { planCommand } from "./commands/plan.js";
import { applyCommand } from "./commands/apply.js";
import { completionsCommand } from "./commands/completions.js";
import { initCommand } from "./commands/init.js";
import { destroyCommand } from "./commands/destroy.js";
import { driftCommand } from "./commands/drift.js";
import { optimizeCommand } from "./commands/optimize.js";
import { listCommand } from "./commands/list.js";
import { setupCommand } from "./commands/setup.js";
import { statusCommand } from "./commands/status.js";
import { reconcileCommand } from "./commands/reconcile.js";
import { doctorCommand } from "./commands/doctor.js";
import { versionCommand } from "./commands/version.js";
import { ProcessExitCode } from "./constants/errors.js";
import { errorToExitCode } from "./utils/exit-code.js";
import {
  SUPPORTED_TYPES_HINT,
  PATTERNS_HINT,
  EXAMPLES_HINT,
} from "./config/constants.js";

import { closeMcpClient } from "./services/mcp-client.js";
import { bootstrapFirstRun } from "./utils/first-run.js";
import { stopSpinner } from "./utils/display.js";
import { checkForUpdates } from "./utils/update-notifier.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(
  readFileSync(resolve(__dirname, "..", "package.json"), "utf-8"),
);

// Self-update UX (Wave H1): non-intrusive banner when a newer version
// of assignee is on npm. No-op pre-publish (private: true → registry
// 404), silent in CI / piped stdout / --json, opt-outable via
// ASSIGNEE_NO_UPDATE_CHECK=1. All errors are swallowed internally.
checkForUpdates({ name: pkg.name as string, version: pkg.version as string });

// First-run detection: auto-create ~/.assignee/ and show welcome (Story 29.6)
bootstrapFirstRun(pkg.version as string);

const program = new Command();

program
  .name("assignee")
  .description("Assignee.ai — AI-Native Cloud Operator")
  .version(pkg.version as string)
  .option(
    "--verbose",
    "Enable structured JSON diagnostic logs to stderr (also: ASSIGNEE_LOG_LEVEL=debug, ASSIGNEE_VERBOSITY=verbose)",
  )
  // Story 50-2: explicit colour control. `chalk@5` honors `NO_COLOR`
  // natively, but we also expose `--color` / `--no-color` for users who
  // want to override the heuristic on a per-invocation basis (e.g. log
  // capture pipelines that want colour, or terminals that mis-report
  // `isTTY`). The preSubcommand hook reconciles all three inputs
  // (`NO_COLOR` env var, `--no-color` flag, `--color` flag) into the
  // single `chalk.level` knob before any subcommand runs.
  .option("--no-color", "Disable ANSI colour output (also: NO_COLOR env var)")
  .option("--color", "Force ANSI colour output even when stdout is not a TTY")
  .configureHelp({ showGlobalOptions: true })
  .addHelpText(
    "after",
    `\n${SUPPORTED_TYPES_HINT}\n\n${PATTERNS_HINT}\n\n${EXAMPLES_HINT}`,
  );

// Propagate the global --verbose flag into ASSIGNEE_LOG_LEVEL so downstream
// code (logger, child processes, MCP servers) picks it up uniformly. The CLI
// flag takes precedence over the env vars — we set the env var here only when
// the flag is present, so an unset flag never clobbers an operator-set
// ASSIGNEE_LOG_LEVEL / ASSIGNEE_VERBOSITY.
//
// Story 50-2: also reconcile --color / --no-color with NO_COLOR. Precedence:
//   1. Explicit --color flag  → force chalk.level ≥ 1 (colour on).
//   2. Explicit --no-color flag (or `color: false` from commander's
//      auto-negation) → chalk.level = 0 (colour off).
//   3. NO_COLOR env var       → chalk.level = 0 (colour off).
//   4. Otherwise              → leave chalk's auto-detection alone.
program.hook("preSubcommand", (thisCommand) => {
  const opts = thisCommand.opts<{
    verbose?: boolean;
    color?: boolean;
  }>();
  if (opts.verbose) {
    process.env["ASSIGNEE_LOG_LEVEL"] = "debug";
  }

  // Commander's `--no-color` surfaces as `opts.color === false`.
  // `--color` surfaces as `opts.color === true`. Undefined means neither
  // flag was passed — defer to NO_COLOR env var + chalk auto-detect.
  if (opts.color === true) {
    if (chalk.level === 0) chalk.level = 1;
  } else if (opts.color === false) {
    chalk.level = 0;
  } else if (process.env["NO_COLOR"] !== undefined) {
    chalk.level = 0;
  }
});

// Dedicated version subcommand (in addition to --version flag) — shows
// richer info including Node version, platform, and the pinned MCP
// server versions. MCP pins are relevant for bug reports because they
// carry their own feature sets; an issue against the pricing or docs
// server is much easier to triage with the exact version stamp.
//
// Story 58-it1-03: extracted to `./commands/version.ts` so the
// completion generator (which walks `program.commands` via
// `program.addCommand`) sees it without needing a hand-maintained stub.
program.addCommand(versionCommand);

program.addCommand(completionsCommand);
program.addCommand(destroyCommand);
program.addCommand(driftCommand);
program.addCommand(optimizeCommand);
program.addCommand(initCommand);
program.addCommand(listCommand);
program.addCommand(planCommand);
program.addCommand(setupCommand);
program.addCommand(statusCommand);
program.addCommand(applyCommand);
program.addCommand(reconcileCommand);
program.addCommand(doctorCommand);

// Propagate `showGlobalOptions: true` to every subcommand so the root-level
// `--verbose` (and any future global options) appear in `<subcommand> --help`
// output. Commander's configureHelp on the root program does not auto-cascade
// to subcommands, so we explicitly walk the command tree once.
for (const sub of program.commands) {
  sub.configureHelp({ showGlobalOptions: true });
}

// EPIPE: stdout pipe closed (e.g. piped to grep/head that exits early).
// Node.js throws by default; suppress and exit cleanly instead.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(ProcessExitCode.SUCCESS);
});

// Graceful shutdown handlers (P2-R2-3).
//
// The signal handler MUST:
//   1. Stop any active clack spinner first — otherwise the cursor stays
//      hidden on some terminals and the label line stays partially drawn.
//      Also emit the DECTCEM "show cursor" sequence as belt-and-suspenders
//      so a crashed spinner can never leave the terminal with a hidden
//      caret.
//   2. Print a visible "Cancelled." marker to stderr so the user sees
//      that their Ctrl-C was honored (prior behavior dropped silently
//      while MCP clients closed in background).
//   3. Close MCP child processes so no orphans remain.
//   4. Flush stderr (async writes from the structured logger) before
//      exiting, otherwise the last log line is lost on fast-exit.
//   5. Exit with the conventional 128 + signum code.
//
// Story 50-2: added SIGHUP (nohup / tmux detach / SSH disconnect) and
// SIGBREAK (Windows Ctrl-Break) handlers so cloud VMs, background
// workflows and Windows users all get the same graceful teardown as
// SIGINT / SIGTERM. SIGBREAK is Node-on-Windows-specific and raises a
// runtime error if registered on non-Windows, so we gate on platform.
//
// Re-entrancy: a second signal during teardown bypasses cleanup and hard
// exits — a stuck MCP close must not trap the user.
let shuttingDown = false;
type ShutdownSignal = "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGBREAK";
function installSignalHandler(signal: ShutdownSignal, code: number) {
  process.on(signal, async () => {
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
  });
}
installSignalHandler("SIGINT", 128 + 2); // 130
installSignalHandler("SIGTERM", 128 + 15); // 143
installSignalHandler("SIGHUP", 128 + 1); // 129
// SIGBREAK is Windows-only (raised by Ctrl-Break). Installing the
// handler on POSIX is a no-op in Node but we gate explicitly so the
// intent is clear.
if (process.platform === "win32") {
  installSignalHandler("SIGBREAK", 128 + 21); // 149 (Node's SIGBREAK signum)
}

program.parseAsync(process.argv).catch((err) => {
  // Story 94-R7 (D-02): command-level catches (e.g. `list.ts`) that
  // have already routed the human-readable message through
  // `renderError` mark their rethrown errors with `alreadyRendered`.
  // Without this guard, the `Error: ${err.message}` write below would
  // paint the entire message (which may embed the supported-types
  // grid) a second time on stderr. We still propagate the exit code
  // unchanged.
  const alreadyRendered =
    err !== null &&
    typeof err === "object" &&
    (err as { alreadyRendered?: unknown }).alreadyRendered === true;
  if (!alreadyRendered) {
    process.stderr.write(
      `Error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
  process.exitCode = errorToExitCode(err);
});
