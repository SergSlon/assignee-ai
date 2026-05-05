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
import { describeCommand } from "./commands/describe.js";
import { destroyCommand } from "./commands/destroy.js";
import { driftCommand } from "./commands/drift.js";
import { optimizeCommand } from "./commands/optimize.js";
import { listCommand } from "./commands/list.js";
import { setupCommand } from "./commands/setup.js";
import { statusCommand } from "./commands/status.js";
import { reconcileCommand } from "./commands/reconcile.js";
import { doctorCommand } from "./commands/doctor.js";
import { restoreProvisionsCommand } from "./commands/restore-provisions.js";
import { auditVerifyCommand } from "./commands/audit-verify.js";
import { versionCommand } from "./commands/version.js";
import { ProcessExitCode } from "./constants/errors.js";
import { errorToExitCode } from "./utils/exit-code.js";
import {
  SUPPORTED_TYPES_HINT,
  PATTERNS_HINT,
  EXAMPLES_HINT,
} from "./config/constants.js";

import { bootstrapFirstRun } from "./utils/first-run.js";
import { checkForUpdates } from "./utils/update-notifier.js";
import { installSignalHandlers } from "./utils/signal-handlers.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Lazy, memoized package.json reader — deferred until the first call site
// that actually needs the version so that module load (including `--help`)
// never pays the synchronous I/O cost.
let _pkg: { name: string; version: string } | undefined;
function getPkg(): { name: string; version: string } {
  if (!_pkg) {
    _pkg = JSON.parse(
      readFileSync(resolve(__dirname, "..", "package.json"), "utf-8"),
    ) as { name: string; version: string };
  }
  return _pkg;
}

// Self-update UX (Wave H1): non-intrusive banner when a newer version
// of assignee is on npm. No-op pre-publish (private: true → registry
// 404), silent in CI / piped stdout / --json, opt-outable via
// ASSIGNEE_NO_UPDATE_CHECK=1. All errors are swallowed internally.
//
// PR-036 (W24c-S3): skip the registry HTTP check entirely when the
// invocation is --help / -h / --version / -V / help sub-command. These
// are "snappy help" calls — a background registry HEAD pollutes the
// event loop and can add perceived latency on slow-proxy networks even
// though the check is deferred.
const _isHelpOrVersion = process.argv.some((a) =>
  ["--help", "-h", "--version", "-V", "help"].includes(a),
);
if (!_isHelpOrVersion) {
  checkForUpdates({ name: getPkg().name, version: getPkg().version });
}

// First-run detection: auto-create ~/.assignee/ and show welcome (Story 29.6)
bootstrapFirstRun(getPkg().version);

const program = new Command();

program
  .name("assignee")
  .description("Assignee.ai - AI-Native Cloud Operator")
  .version(getPkg().version)
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
    `\n${SUPPORTED_TYPES_HINT}\n\n${PATTERNS_HINT}\n\n${EXAMPLES_HINT}\n\nDemo / screenshot env vars:\n  ASSIGNEE_DEMO_REDACT_ACCOUNT=1   Redact account IDs in all output (for demos / screenshots)`,
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
program.addCommand(describeCommand);
program.addCommand(destroyCommand);
program.addCommand(driftCommand);
program.addCommand(optimizeCommand);
program.addCommand(initCommand);
program.addCommand(listCommand);
program.addCommand(planCommand);
program.addCommand(setupCommand);
program.addCommand(statusCommand);
program.addCommand(restoreProvisionsCommand);
program.addCommand(auditVerifyCommand);
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

// Graceful shutdown handlers (P2-R2-3) — extracted to utils/signal-handlers.ts
// (W14-S2) so that tests can target the handler logic directly without
// instantiating the full Commander program tree.
installSignalHandlers();

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
  // Epic 98 e98.W5.N3 (D-01 closure): under `--json` / `--output json`,
  // the per-command JSON wrapper has already emitted the error as a
  // structured envelope on stdout. The top-level `Error: ...` stderr
  // write would duplicate that message into a `jq | tee stderr.log`
  // pipeline as human-formatted prose — exactly the leak D-01 flagged
  // (e.g. `plan "" --json` leaking `Error: Missing intent...`).
  // Detect JSON mode from argv because the filter this catch lives
  // outside of the command action, so the per-action
  // `installJsonStderrFilter` has already been torn down by the time
  // we get here. argv parsing is cheap and correct: Commander expands
  // nothing before the parseAsync promise settles, so the raw flags
  // are authoritative for the just-failed invocation.
  const argv = process.argv;
  const jsonMode =
    argv.includes("--json") ||
    (() => {
      const idx = argv.indexOf("--output");
      if (idx >= 0 && argv[idx + 1] === "json") return true;
      const short = argv.indexOf("-o");
      if (short >= 0 && argv[short + 1] === "json") return true;
      return false;
    })();
  if (!alreadyRendered && !jsonMode) {
    process.stderr.write(
      `Error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
  process.exitCode = errorToExitCode(err);
});
