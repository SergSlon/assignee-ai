#!/usr/bin/env npx tsx
/**
 * Generate static shell completion scripts for bundling in the npm package.
 *
 * Imports the shared `buildAssigneeProgram()` factory so the build-time
 * artifacts always reflect the SAME tree shape the runtime CLI ships.
 *
 * Outputs:
 *   completions/assignee.zsh
 *   completions/assignee.bash
 *   completions/assignee.fish
 *
 * Run via: npx tsx scripts/generate-completions.ts (executed during the
 * `assignee:postbuild` hook from `package.json`).
 *
 * @see Story 108-A-05 — v1.0 API freeze, noun-grouped command tree
 *      (infra/admin/dev). Round 2 introduces `apps/cli/src/program.ts` as the
 *      single source of truth so this script and `src/index.ts` cannot drift.
 *      Pre-refactor this file rebuilt a flat tree, causing the bundled
 *      completion artifacts to ship 17 flat leaves while the runtime shipped
 *      the noun-grouped tree (Quinn BOUNCE BLOCKER #1).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  generateCompletionScript,
  SUPPORTED_SHELLS,
} from "../src/services/completion-generator.js";
import { buildAssigneeProgram } from "../src/program.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const completionsDir = path.resolve(__dirname, "..", "completions");

// ── Main ────────────────────────────────────────────────────────────────────

fs.mkdirSync(completionsDir, { recursive: true });

const program = buildAssigneeProgram();
// Match the runtime program metadata so the generated completion scripts
// emit the canonical binary name (`assignee`). Version isn't read by the
// completion generator but kept here for parity with the runtime.
program.name("assignee").version("0.1.0");

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
