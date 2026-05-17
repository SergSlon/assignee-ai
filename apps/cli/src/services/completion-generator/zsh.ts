/**
 * Zsh completion script generator. Output is consumed verbatim by
 * `apps/cli/completions/assignee.zsh` — any change here MUST preserve
 * the byte-identical output for an unchanged command tree.
 *
 * Split out of the monolithic `completion-generator.ts` during Epic 51
 * iteration 1 (Story 51-it1-B2).
 *
 * Story 108-A-05: updated to handle two-level noun-group command tree
 * (infra / admin / dev → leaf commands).
 */

import type { CommandInfo } from "./types.js";

export function generateZshCompletions(
  programName: string,
  commands: CommandInfo[],
): string {
  const lines: string[] = [];

  lines.push(`#compdef ${programName}`);
  lines.push("");
  lines.push(`# Zsh completion script for ${programName}`);
  lines.push(`# Generated automatically from the Commander.js command tree.`);
  lines.push(
    `# Install: eval "$(${programName} completions zsh)" or add to ~/.zshrc`,
  );
  lines.push("");
  lines.push(`_${programName}() {`);
  lines.push(`  local -a commands`);
  lines.push("");
  lines.push(`  _arguments -C \\`);
  lines.push(`    '1:command:->command' \\`);
  lines.push(`    '*::arg:->args'`);
  lines.push("");
  lines.push(`  case "$state" in`);
  lines.push(`    command)`);
  lines.push(`      commands=(`);
  for (const cmd of commands) {
    const desc = escapeZshString(cmd.description);
    lines.push(`        '${cmd.name}:${desc}'`);
  }
  lines.push(`      )`);
  lines.push(`      _describe 'command' commands`);
  lines.push(`      ;;`);
  lines.push(`    args)`);
  lines.push(`      case "\${words[1]}" in`);

  for (const cmd of commands) {
    lines.push(`        ${cmd.name})`);
    if (cmd.subCommands.length > 0) {
      // Noun-group: emit sub-command completions for the second word.
      lines.push(`          local -a sub_commands`);
      lines.push(`          sub_commands=(`);
      for (const sub of cmd.subCommands) {
        const subDesc = escapeZshString(sub.description);
        lines.push(`            '${sub.name}:${subDesc}'`);
      }
      lines.push(`          )`);
      lines.push(`          _describe 'sub-command' sub_commands`);
    } else if (cmd.options.length > 0) {
      lines.push(`          _arguments \\`);
      const optLines: string[] = [];
      for (const opt of cmd.options) {
        const desc = escapeZshString(opt.description);
        if (opt.argName) {
          optLines.push(`            '${opt.long}[${desc}]:${opt.argName}:'`);
        } else {
          optLines.push(`            '${opt.long}[${desc}]'`);
        }
      }
      lines.push(optLines.join(" \\\n"));
    }
    lines.push(`          ;;`);
  }

  lines.push(`      esac`);
  lines.push(`      ;;`);
  lines.push(`  esac`);
  lines.push(`}`);
  lines.push("");
  lines.push(`_${programName}`);
  lines.push("");

  return lines.join("\n");
}

function escapeZshString(s: string): string {
  return s.replace(/'/g, "'\\''").replace(/:/g, "\\:");
}
