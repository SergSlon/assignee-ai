/**
 * `assignee dev completions <shell>` command — outputs shell completion scripts.
 *
 * Generates completion scripts from the Commander.js command tree and writes
 * them to stdout for sourcing. No spinners, no branded output — just the script.
 *
 * Usage:
 *   eval "$(assignee dev completions zsh)"   # Zsh — add to ~/.zshrc
 *   eval "$(assignee dev completions bash)"  # Bash — add to ~/.bashrc
 *   assignee dev completions fish | source   # Fish — or save to
 *                                            #   ~/.config/fish/completions/assignee.fish
 *
 * Story 108-A-05: moved from flat `completions` to `dev completions`.
 * The command walks up to the ROOT program (grandparent) so the generated
 * completion script reflects the full noun-grouped command tree.
 *
 * @see Story 18.2, ADR-010
 */

import { Command } from "commander";
import { CommandName, CommandDescription } from "../constants/commands.js";
import { AssigneeError } from "@assignee/core";
import { ErrorCode } from "../constants/errors.js";
import {
  generateCompletionScript,
  SUPPORTED_SHELLS,
  type SupportedShell,
} from "../services/completion-generator.js";

export const completionsCommand = new Command(CommandName.COMPLETIONS)
  .description(CommandDescription.COMPLETIONS)
  .argument("<shell>", `Shell type: ${SUPPORTED_SHELLS.join(", ")}`)
  .addHelpText(
    "after",
    `
Examples:
  eval "$(assignee dev completions zsh)"    # Zsh — add to ~/.zshrc
  eval "$(assignee dev completions bash)"   # Bash — add to ~/.bashrc
  assignee dev completions fish | source    # Fish — or save to ~/.config/fish/completions/`,
  )
  .action((shell: string) => {
    const normalizedShell = shell.toLowerCase();

    if (!SUPPORTED_SHELLS.includes(normalizedShell as SupportedShell)) {
      throw new AssigneeError(
        `Unsupported shell "${shell}". Valid options: ${SUPPORTED_SHELLS.join(", ")}`,
        ErrorCode.USAGE_ERROR,
      );
    }

    // Walk up to the ROOT program (grandparent: leaf → group → root) to get
    // the full command tree. With the noun-grouped tree, `completionsCommand`
    // lives under `devGroup` which lives under `program`. We need the root
    // so the generated completion script reflects all three noun groups.
    //
    // Why we do NOT call `buildAssigneeProgram()` here: Commander Command
    // instances are mutable — each `addCommand(child)` re-parents the child
    // by setting `child.parent`. Calling the factory at runtime would build
    // a second tree using the same imported `completionsCommand` instance
    // and re-parent it, severing it from the live runtime tree. The
    // parent-walk is the safe, side-effect-free way to get the runtime
    // root from inside an action handler.
    let root: Command = completionsCommand;
    while (root.parent !== null) {
      root = root.parent;
    }
    const program = root;

    const script = generateCompletionScript(
      program,
      normalizedShell as SupportedShell,
    );

    process.stdout.write(script);
  });
