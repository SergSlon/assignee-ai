/**
 * Enriches option labels with contextual metadata (cost, fit, recommendation).
 * Pure string transformation — zero I/O, zero async.
 *
 * @see Story 10.2
 */

import chalk from "chalk";
import type { OptionMetadata } from "@assignee/core";

type EnrichableOption = { value: string; label: string } & OptionMetadata;

/**
 * Builds an enriched label string from option metadata.
 * Appends cost hint, fit hint, and recommended flag using `·` separator.
 * Returns original label unchanged if no metadata is present.
 *
 * Format: "{existingLabel} · {costHint} · {fitHint} ★ Recommended"
 */
export function enrichOptionLabel(option: EnrichableOption): string {
  const parts: string[] = [];

  if (option.costHint) {
    parts.push(chalk.dim(option.costHint));
  }
  if (option.fitHint) {
    parts.push(chalk.dim(option.fitHint));
  }
  if (option.recommended) {
    parts.push(chalk.green.bold("★ Recommended"));
  }

  if (parts.length === 0) return option.label;

  return `${option.label} · ${parts.join(" · ")}`;
}
