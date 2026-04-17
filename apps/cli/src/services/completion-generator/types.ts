/**
 * Shared types + shell enum for the completion-generator family.
 *
 * Split out of `apps/cli/src/services/completion-generator.ts` during
 * Epic 51 iteration 1 (Story 51-it1-B2): the original 294-LOC file
 * bundled three shell generators (zsh/bash/fish) + the Commander.js
 * extraction logic. Each shell generator now lives in its own module
 * and imports these types.
 */

/** Supported shell types for completion generation. */
export const SUPPORTED_SHELLS = ["zsh", "bash", "fish"] as const;
export type SupportedShell = (typeof SUPPORTED_SHELLS)[number];

/** Extracted command metadata from the Commander.js tree. */
export interface CommandInfo {
  name: string;
  description: string;
  aliases: string[];
  options: OptionInfo[];
  args: ArgInfo[];
}

/** Extracted option metadata. */
export interface OptionInfo {
  flags: string; // e.g. "--yes" or "-o, --output <format>"
  long: string; // e.g. "--yes"
  short?: string; // e.g. "-o"
  description: string;
  isRequired: boolean;
  argName?: string; // e.g. "format" if option takes a value
}

/** Extracted argument metadata. */
export interface ArgInfo {
  name: string;
  description: string;
  required: boolean;
  choices?: string[];
}
