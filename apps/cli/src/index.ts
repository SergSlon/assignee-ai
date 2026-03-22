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
import { listCommand } from "./commands/list.js";
import { setupCommand } from "./commands/setup.js";
import { statusCommand } from "./commands/status.js";
import { ProcessExitCode } from "./constants/errors.js";
import { SUPPORTED_TYPES_HINT } from "./config/constants.js";

import { closeMcpClient } from "./services/mcp-client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(
  readFileSync(resolve(__dirname, "..", "package.json"), "utf-8"),
);

const program = new Command();

program
  .name("assignee")
  .description("Assignee.ai — AI-Native Cloud Operator")
  .version(pkg.version as string)
  .addHelpText("after", `\n${SUPPORTED_TYPES_HINT}`);

program.addCommand(completionsCommand);
program.addCommand(destroyCommand);
program.addCommand(initCommand);
program.addCommand(listCommand);
program.addCommand(planCommand);
program.addCommand(setupCommand);
program.addCommand(statusCommand);
program.addCommand(applyCommand);

// EPIPE: stdout pipe closed (e.g. piped to grep/head that exits early).
// Node.js throws by default; suppress and exit cleanly instead.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(ProcessExitCode.SUCCESS);
});

// Graceful shutdown handlers for MCP servers
process.on("SIGINT", async () => {
  await closeMcpClient();
  process.exit(ProcessExitCode.SUCCESS);
});

process.on("SIGTERM", async () => {
  await closeMcpClient();
  process.exit(ProcessExitCode.SUCCESS);
});

program.parseAsync(process.argv);
