/**
 * Shell completion script generator for assignee CLI.
 *
 * Walks the Commander.js command tree to extract commands, options,
 * and arguments, then generates shell-specific completion scripts.
 *
 * @see Story 18.2, AC #3, #4
 */

import type { Command, Option } from "commander";

/** Supported shell types for completion generation. */
export const SUPPORTED_SHELLS = ["zsh", "bash", "fish"] as const;
export type SupportedShell = (typeof SUPPORTED_SHELLS)[number];

/** Extracted command metadata from the Commander.js tree. */
interface CommandInfo {
  name: string;
  description: string;
  aliases: string[];
  options: OptionInfo[];
  args: ArgInfo[];
}

/** Extracted option metadata. */
interface OptionInfo {
  flags: string; // e.g. "--yes" or "-o, --output <format>"
  long: string; // e.g. "--yes"
  short?: string; // e.g. "-o"
  description: string;
  isRequired: boolean;
  argName?: string; // e.g. "format" if option takes a value
}

/** Extracted argument metadata. */
interface ArgInfo {
  name: string;
  description: string;
  required: boolean;
  choices?: string[];
}

/**
 * Walk the Commander.js command tree and extract all subcommand metadata.
 */
export function extractCommands(program: Command): CommandInfo[] {
  const commands: CommandInfo[] = [];

  for (const cmd of program.commands) {
    const options: OptionInfo[] = [];

    for (const opt of cmd.options as Option[]) {
      const longFlag = opt.long ?? "";
      const shortFlag = opt.short;
      options.push({
        flags: opt.flags,
        long: longFlag,
        short: shortFlag,
        description: opt.description ?? "",
        isRequired: opt.required ?? false,
        argName: opt.flags.includes("<")
          ? extractArgName(opt.flags)
          : undefined,
      });
    }

    const args: ArgInfo[] = [];
    for (const arg of (
      cmd as unknown as {
        registeredArguments: Array<{
          name: () => string;
          description: string;
          required: boolean;
        }>;
      }
    ).registeredArguments ?? []) {
      args.push({
        name: arg.name(),
        description: arg.description ?? "",
        required: arg.required,
      });
    }

    commands.push({
      name: cmd.name(),
      description: cmd.description(),
      aliases: cmd.aliases(),
      options,
      args,
    });
  }

  return commands;
}

/** Extract argument name from option flags like "--output <format>". */
function extractArgName(flags: string): string {
  const match = flags.match(/<([^>]+)>/);
  return match?.[1] ?? "";
}

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

// ── Zsh ─────────────────────────────────────────────────────────────────────

function generateZshCompletions(
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
    if (cmd.options.length > 0) {
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

// ── Bash ────────────────────────────────────────────────────────────────────

function generateBashCompletions(
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

  const commandNames = commands.map((c) => c.name).join(" ");
  lines.push(`  commands="${commandNames}"`);
  lines.push("");
  lines.push(`  if [[ \${COMP_CWORD} -eq 1 ]]; then`);
  lines.push(`    COMPREPLY=( $(compgen -W "\${commands}" -- "\${cur}") )`);
  lines.push(`    return 0`);
  lines.push(`  fi`);
  lines.push("");
  lines.push(`  local command="\${COMP_WORDS[1]}"`);
  lines.push(`  case "\${command}" in`);

  for (const cmd of commands) {
    const optFlags = cmd.options.map((o) => o.long).join(" ");
    lines.push(`    ${cmd.name})`);
    lines.push(`      COMPREPLY=( $(compgen -W "${optFlags}" -- "\${cur}") )`);
    lines.push(`      ;;`);
  }

  lines.push(`  esac`);
  lines.push(`  return 0`);
  lines.push(`}`);
  lines.push("");
  lines.push(`complete -F ${funcName} ${programName}`);
  lines.push("");

  return lines.join("\n");
}

// ── Fish ────────────────────────────────────────────────────────────────────

function generateFishCompletions(
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
