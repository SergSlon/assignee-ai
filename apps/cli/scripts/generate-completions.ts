#!/usr/bin/env npx tsx
/**
 * Generate static shell completion scripts for bundling in the npm package.
 *
 * Imports the real command modules to build the program tree, ensuring
 * the generated completions always stay in sync with the actual CLI.
 *
 * Outputs:
 *   completions/assignee.zsh
 *   completions/assignee.bash
 *   completions/assignee.fish
 *
 * Run via: npx tsx scripts/generate-completions.ts
 *
 * @see Story 18.2, AC #5
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import {
  generateCompletionScript,
  SUPPORTED_SHELLS,
} from "../src/services/completion-generator.js";
import { planCommand } from "../src/commands/plan.js";
import { applyCommand } from "../src/commands/apply.js";
import { initCommand } from "../src/commands/init.js";
import { completionsCommand } from "../src/commands/completions.js";
import { destroyCommand } from "../src/commands/destroy.js";
import { driftCommand } from "../src/commands/drift.js";
import { optimizeCommand } from "../src/commands/optimize.js";
import { listCommand } from "../src/commands/list.js";
import { setupCommand } from "../src/commands/setup.js";
import { statusCommand } from "../src/commands/status.js";
import { reconcileCommand } from "../src/commands/reconcile.js";
import { doctorCommand } from "../src/commands/doctor.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const completionsDir = path.resolve(__dirname, "..", "completions");

/**
 * Build the program by importing the real command modules.
 * This avoids manually duplicating flags/args and prevents sync drift.
 */
function buildProgram(): Command {
  const program = new Command();
  program.name("assignee").version("0.1.0");

  // Keep this list in sync with apps/cli/src/index.ts so shell
  // completions cover every shipping command. Story 50-3 trimmed the
  // list from 18 → 13 by removing clean, cache, patterns, types, whoami.
  program.addCommand(planCommand);
  program.addCommand(applyCommand);
  program.addCommand(initCommand);
  program.addCommand(completionsCommand);
  program.addCommand(destroyCommand);
  program.addCommand(driftCommand);
  program.addCommand(optimizeCommand);
  program.addCommand(listCommand);
  program.addCommand(setupCommand);
  program.addCommand(statusCommand);
  program.addCommand(reconcileCommand);
  program.addCommand(doctorCommand);

  return program;
}

// ── Main ────────────────────────────────────────────────────────────────────

fs.mkdirSync(completionsDir, { recursive: true });

const program = buildProgram();

const shellExtensions: Record<string, string> = {
  zsh: "zsh",
  bash: "bash",
  fish: "fish",
};

for (const shell of SUPPORTED_SHELLS) {
  const script = generateCompletionScript(program, shell);
  const filename = `assignee.${shellExtensions[shell]}`;
  const filePath = path.join(completionsDir, filename);
  fs.writeFileSync(filePath, script, "utf-8");
  process.stderr.write(`Generated ${filePath}\n`);
}

process.stderr.write("Shell completion scripts generated successfully.\n");
