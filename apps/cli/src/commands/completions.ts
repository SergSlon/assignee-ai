/**
 * `assignee completions <shell>` command — outputs shell completion scripts.
 *
 * Generates completion scripts from the Commander.js command tree and writes
 * them to stdout for sourcing. No spinners, no branded output — just the script.
 *
 * Usage:
 *   eval "$(assignee completions zsh)"   # Zsh — add to ~/.zshrc
 *   eval "$(assignee completions bash)"  # Bash — add to ~/.bashrc
 *   assignee completions fish | source   # Fish — or save to
 *                                        #   ~/.config/fish/completions/assignee.fish
 *
 * @see Story 18.2, ADR-010
 */

import { Command } from "commander";
import { CommandName, CommandDescription } from "../constants/commands.js";
import {
  generateCompletionScript,
  SUPPORTED_SHELLS,
  type SupportedShell,
} from "../services/completion-generator.js";

export const completionsCommand = new Command(CommandName.COMPLETIONS)
  .description(CommandDescription.COMPLETIONS)
  .argument("<shell>", `Shell type: ${SUPPORTED_SHELLS.join(", ")}`)
  .action((shell: string) => {
    const normalizedShell = shell.toLowerCase();

    if (!SUPPORTED_SHELLS.includes(normalizedShell as SupportedShell)) {
      process.stderr.write(
        `Error: unsupported shell "${shell}". Valid options: ${SUPPORTED_SHELLS.join(", ")}\n`,
      );
      process.exit(1);
    }

    // Walk up to the root program (parent of this command) to get the full command tree.
    const program = completionsCommand.parent ?? completionsCommand;

    const script = generateCompletionScript(
      program,
      normalizedShell as SupportedShell,
    );

    process.stdout.write(script);
  });
