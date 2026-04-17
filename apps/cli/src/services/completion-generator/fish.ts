/**
 * Fish completion script generator. Output is consumed verbatim by
 * `apps/cli/completions/assignee.fish` — any change here MUST preserve
 * the byte-identical output for an unchanged command tree.
 *
 * Split out of the monolithic `completion-generator.ts` during Epic 51
 * iteration 1 (Story 51-it1-B2).
 */

import type { CommandInfo } from "./types.js";

export function generateFishCompletions(
  programName: string,
  commands: CommandInfo[],
): string {
  const lines: string[] = [];

  lines.push(`# Fish completion script for ${programName}`);
  lines.push(`# Generated automatically from the Commander.js command tree.`);
  lines.push(`# Install: ${programName} completions fish | source`);
  lines.push(`#   or save to ~/.config/fish/completions/${programName}.fish`);
  lines.push("");

  // Disable file completions by default for the top-level command
  lines.push(`complete -c ${programName} -f`);
  lines.push("");

  // Subcommands (only when no subcommand is already given)
  const subcommandCondition = `__fish_use_subcommand`;
  for (const cmd of commands) {
    lines.push(
      `complete -c ${programName} -n ${subcommandCondition} -a ${cmd.name} -d '${escapeFishString(cmd.description)}'`,
    );
  }

  lines.push("");

  // Per-subcommand options
  for (const cmd of commands) {
    if (cmd.options.length === 0) continue;

    lines.push(`# Options for '${cmd.name}'`);
    for (const opt of cmd.options) {
      const longName = opt.long.replace(/^--/, "");
      let completionParts = `complete -c ${programName} -n "__fish_seen_subcommand_from ${cmd.name}" -l ${longName}`;
      if (opt.short) {
        completionParts += ` -s ${opt.short.replace(/^-/, "")}`;
      }
      if (opt.argName) {
        completionParts += ` -r`;
      }
      completionParts += ` -d '${escapeFishString(opt.description)}'`;
      lines.push(completionParts);
    }
    lines.push("");
  }

  return lines.join("\n");
}

function escapeFishString(s: string): string {
  return s.replace(/'/g, "\\'");
}
