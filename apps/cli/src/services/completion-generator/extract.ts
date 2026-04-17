/**
 * Commander.js tree walker — extracts command/option/arg metadata into
 * shell-agnostic `CommandInfo[]` for the per-shell generators to consume.
 *
 * Split out of the monolithic `completion-generator.ts` during Epic 51
 * iteration 1 (Story 51-it1-B2).
 */

import type { Command, Option } from "commander";
import type { ArgInfo, CommandInfo, OptionInfo } from "./types.js";

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
