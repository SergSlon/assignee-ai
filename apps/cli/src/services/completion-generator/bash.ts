/**
 * Bash completion script generator. Output is consumed verbatim by
 * `apps/cli/completions/assignee.bash` — any change here MUST preserve
 * the byte-identical output for an unchanged command tree.
 *
 * Split out of the monolithic `completion-generator.ts` during Epic 51
 * iteration 1 (Story 51-it1-B2).
 *
 * Story 108-A-05: updated to handle two-level noun-group command tree
 * (infra / admin / dev → leaf commands).
 */

import type { CommandInfo } from "./types.js";

export function generateBashCompletions(
  programName: string,
  commands: CommandInfo[],
): string {
  const lines: string[] = [];
  const funcName = `_${programName}_completions`;

  lines.push(`# Bash completion script for ${programName}`);
  lines.push(`# Generated automatically from the Commander.js command tree.`);
  lines.push(
    `# Install: eval "$(${programName} completions bash)" or add to ~/.bashrc`,
  );
  lines.push("");
  lines.push(`${funcName}() {`);
  lines.push(`  local cur prev commands`);
  lines.push(`  COMPREPLY=()`);
  lines.push(`  cur="\${COMP_WORDS[COMP_CWORD]}"`);
  lines.push(`  prev="\${COMP_WORDS[COMP_CWORD-1]}"`);
  lines.push("");

  const topLevelNames = commands.map((c) => c.name).join(" ");
  lines.push(`  commands="${topLevelNames}"`);
  lines.push("");
  lines.push(`  if [[ \${COMP_CWORD} -eq 1 ]]; then`);
  lines.push(`    COMPREPLY=( $(compgen -W "\${commands}" -- "\${cur}") )`);
  lines.push(`    return 0`);
  lines.push(`  fi`);
  lines.push("");
  lines.push(`  local command="\${COMP_WORDS[1]}"`);
  lines.push(`  case "\${command}" in`);

  for (const cmd of commands) {
    if (cmd.subCommands.length > 0) {
      // Noun-group: complete the second word with sub-command names.
      const subNames = cmd.subCommands.map((s) => s.name).join(" ");
      lines.push(`    ${cmd.name})`);
      lines.push(`      if [[ \${COMP_CWORD} -eq 2 ]]; then`);
      lines.push(
        `        COMPREPLY=( $(compgen -W "${subNames}" -- "\${cur}") )`,
      );
      lines.push(`      else`);
      lines.push(`        local sub="\${COMP_WORDS[2]}"; case "\${sub}" in`);
      for (const sub of cmd.subCommands) {
        const optFlags = sub.options.map((o) => o.long).join(" ");
        lines.push(`          ${sub.name})`);
        lines.push(
          `            COMPREPLY=( $(compgen -W "${optFlags}" -- "\${cur}") )`,
        );
        lines.push(`            ;;`);
      }
      lines.push(`        esac`);
      lines.push(`      fi`);
      lines.push(`      ;;`);
    } else {
      const optFlags = cmd.options.map((o) => o.long).join(" ");
      lines.push(`    ${cmd.name})`);
      lines.push(
        `      COMPREPLY=( $(compgen -W "${optFlags}" -- "\${cur}") )`,
      );
      lines.push(`      ;;`);
    }
  }

  lines.push(`  esac`);
  lines.push(`  return 0`);
  lines.push(`}`);
  lines.push("");
  lines.push(`complete -F ${funcName} ${programName}`);
  lines.push("");

  return lines.join("\n");
}
