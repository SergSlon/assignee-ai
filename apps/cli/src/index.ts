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
import { cleanCommand } from "./commands/clean.js";
import { reconcileCommand } from "./commands/reconcile.js";
import { cacheCommand } from "./commands/cache.js";
import { doctorCommand } from "./commands/doctor.js";
import { whoamiCommand } from "./commands/whoami.js";
import { patternsCommand } from "./commands/patterns.js";
import { typesCommand } from "./commands/types.js";
import { ProcessExitCode } from "./constants/errors.js";
import {
  SUPPORTED_TYPES_HINT,
  PATTERNS_HINT,
  EXAMPLES_HINT,
} from "./config/constants.js";

import { closeMcpClient } from "./services/mcp-client.js";
import { bootstrapFirstRun } from "./utils/first-run.js";
import { stopSpinner } from "./utils/display.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(
  readFileSync(resolve(__dirname, "..", "package.json"), "utf-8"),
);

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
program.hook("preSubcommand", (thisCommand) => {
  const opts = thisCommand.opts<{ verbose?: boolean }>();
  if (opts.verbose) {
    process.env["ASSIGNEE_LOG_LEVEL"] = "debug";
  }
});

// Dedicated version subcommand (in addition to --version flag) — shows
// richer info including Node version, platform, and the pinned MCP
// server versions. MCP pins are relevant for bug reports because they
// carry their own feature sets; an issue against the pricing or docs
// server is much easier to triage with the exact version stamp.
program
  .command("version")
  .description("Show version and environment info")
  .action(async () => {
    const { MCP_PINS } = await import("./config/mcp-servers.js");
    const lines = [
      `assignee ${pkg.version as string}`,
      `node     ${process.version}`,
      `platform ${process.platform} ${process.arch}`,
      "",
      "Pinned MCP servers:",
      `  pricing        ${MCP_PINS.AWS_PRICING}`,
      `  documentation  ${MCP_PINS.AWS_DOCUMENTATION}`,
      `  iam            ${MCP_PINS.AWS_IAM}`,
      `  wa-security    ${MCP_PINS.AWS_WA_SECURITY}`,
      `  cost-mgmt      ${MCP_PINS.AWS_COST_MANAGEMENT}`,
    ];
    process.stdout.write(lines.join("\n") + "\n");
  });

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
program.addCommand(cleanCommand);
program.addCommand(reconcileCommand);
program.addCommand(cacheCommand);
program.addCommand(doctorCommand);
program.addCommand(whoamiCommand);
program.addCommand(patternsCommand);
program.addCommand(typesCommand);

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
// The SIGINT handler MUST:
//   1. Stop any active clack spinner first — otherwise the cursor stays
//      hidden on some terminals and the label line stays partially drawn.
//   2. Print a visible "Cancelled." marker to stderr so the user sees
//      that their Ctrl-C was honored (prior behavior dropped silently
//      while MCP clients closed in background).
//   3. Close MCP child processes so no orphans remain.
//   4. Flush stderr (async writes from the structured logger) before
//      exiting, otherwise the last log line is lost on fast-exit.
//   5. Exit with the conventional 128 + signum code.
//
// Re-entrancy: second Ctrl-C during teardown bypasses cleanup and hard
// exits — a stuck MCP close must not trap the user.
let shuttingDown = false;
function installSignalHandler(signal: "SIGINT" | "SIGTERM", code: number) {
  process.on(signal, async () => {
    if (shuttingDown) {
      // Second signal during teardown — abandon cleanup.
      process.exit(code);
    }
    shuttingDown = true;
    try {
      stopSpinner();
    } catch {
      /* spinner may not exist — non-fatal */
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

program.parseAsync(process.argv).catch((err) => {
  process.stderr.write(
    `Error: ${err instanceof Error ? err.message : String(err)}\n`,
  );
  process.exitCode = 1;
});
