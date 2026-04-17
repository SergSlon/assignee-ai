/**
 * Discovery help block for `assignee plan --help`.
 *
 * Story 50-3 removed the dedicated `assignee patterns` and
 * `assignee types` commands. Their content now lives here as a
 * generated help section surfaced through `plan --help`.
 *
 * Folded content:
 *  - Compound pattern list (patternId + displayName + resource count)
 *  - Supported resource type list (grouped by SUPPORTED_TYPES_ARRAY)
 *
 * Generation is lazy + synchronous (no runtime cost when --help is not
 * printed) and sourced directly from `@assignee/core` so adding a new
 * pattern / type in core automatically shows up in help.
 */

import { SUPPORTED_TYPES_ARRAY, defaultPatternRegistry } from "@assignee/core";

/**
 * Render the compound-pattern discovery block. Listed in registration
 * (= precedence) order, matching the pattern-registry's first-match-wins
 * routing.
 */
export function renderCompoundPatternsBlock(): string {
  const patterns = defaultPatternRegistry.list();
  if (patterns.length === 0) return "";

  const lines: string[] = [];
  lines.push(
    `Compound patterns (${patterns.length}, first keyword match wins):`,
  );
  for (const p of patterns) {
    lines.push(
      `  ${p.patternId.padEnd(26)} ${p.displayName} (${p.resourceList.length} resources)`,
    );
  }
  return lines.join("\n");
}

/**
 * Render the supported resource-type discovery block. Listed in the
 * SUPPORTED_TYPES_ARRAY order (which is itself curated — see
 * packages/core/src/constants/SUPPORTED_TYPES_ARRAY).
 *
 * Guarded against an impossibly-empty array even though the curated
 * constant is currently length-37; future zero-length edits would
 * collapse this section silently.
 */
export function renderResourceTypesBlock(): string {
  const count = SUPPORTED_TYPES_ARRAY.length as number;
  if (count === 0) return "";

  const lines: string[] = [];
  lines.push(`Resource types (${count}):`);
  // Two-column layout for scannability when the list is long.
  const width = Math.max(...SUPPORTED_TYPES_ARRAY.map((t) => t.length));
  const pairs: string[] = [];
  for (let i = 0; i < SUPPORTED_TYPES_ARRAY.length; i += 2) {
    const left = SUPPORTED_TYPES_ARRAY[i]!.padEnd(width + 2);
    const right = SUPPORTED_TYPES_ARRAY[i + 1] ?? "";
    pairs.push(`  ${left}${right}`.trimEnd());
  }
  lines.push(...pairs);
  return lines.join("\n");
}

/**
 * Full discovery section appended to `plan --help`.
 * Combines compound patterns + resource types into one block.
 */
export function renderDiscoveryBlock(): string {
  const blocks = [renderCompoundPatternsBlock(), renderResourceTypesBlock()]
    .filter((b) => b.length > 0)
    .join("\n\n");
  return blocks;
}
