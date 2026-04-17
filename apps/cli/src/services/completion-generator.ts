/**
 * Shell completion orchestrator for the assignee CLI.
 *
 * Walks the Commander.js command tree (via `extractCommands`) and dispatches
 * to the per-shell generator (`zsh.ts` / `bash.ts` / `fish.ts`). Each
 * generator now lives in `./completion-generator/` so the file-per-shell
 * SOLID boundary is explicit and individual shell generators can evolve
 * without growing a 300-LOC god-file.
 *
 * The public surface (re-exported below) is unchanged so
 * `./completion-generator.test.ts`, `commands/completions.ts`, and
 * `scripts/generate-completions.ts` keep working. Generated completion
 * scripts under `apps/cli/completions/` remain byte-identical.
 *
 * @see Story 18.2, AC #3, #4 (original)
 * @see Story 51-it1-B2 (split, 2026-04-17)
 */

import type { Command } from "commander";
import { extractCommands } from "./completion-generator/extract.js";
import { generateBashCompletions } from "./completion-generator/bash.js";
import { generateFishCompletions } from "./completion-generator/fish.js";
import { generateZshCompletions } from "./completion-generator/zsh.js";
import {
  SUPPORTED_SHELLS,
  type SupportedShell,
} from "./completion-generator/types.js";

export { SUPPORTED_SHELLS, extractCommands };
export type { SupportedShell };

/**
 * Generate a completion script for the given shell.
 */
export function generateCompletionScript(
  program: Command,
  shell: SupportedShell,
): string {
  const commands = extractCommands(program);
  const programName = program.name();

  switch (shell) {
    case "zsh":
      return generateZshCompletions(programName, commands);
    case "bash":
      return generateBashCompletions(programName, commands);
    case "fish":
      return generateFishCompletions(programName, commands);
  }
}
