#!/usr/bin/env node

// Load .env from repo root before any other imports read process.env.
// Silent no-op in CI where env vars are injected directly.
try {
  process.loadEnvFile();
} catch {
  // .env not present — rely on shell environment
}

import { Command } from "commander";
import { planCommand } from "./commands/plan.js";
import { applyCommand } from "./commands/apply.js";
import { ProcessExitCode } from "./constants/errors.js";

import { closeMcpClient } from "./services/mcp-client.js";

const program = new Command();

program
  .name("assignee")
  .description("Assignee.ai — AI-Native Cloud Operator")
  .version("0.1.0");

program.addCommand(planCommand);
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
