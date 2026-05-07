/**
 * Plan rendering helpers for Assignee.ai CLI.
 * Extracted from display.ts — renderPlanBox, formatCostLine, formatPricingBreakdown,
 * formatAppliedFixes, formatFixValue, formatAutoFixHint, regionLabel.
 *
 * Epic 92 Wave 2.c (A-02): also exposes the compound JSON envelope
 * serializer used by the CLI `plan.ts` stdout interceptor so the
 * envelope shape is a single source of truth the e2e test can rely on.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import chalk from "chalk";
import boxen from "boxen";
import { AWS_REGION } from "../config/constants/aws.js";
import { BEDROCK_MODEL_ID } from "../config/constants/saas.js";
import { BoxenAlign, BoxenBorderColor } from "../config/constants/ui.js";
import type { AppliedFix } from "../types/fix-finding.js";
import { CostEstimateLabel } from "../pricing/filter-constants.js";
import { formatLabelWithSource, type DataSource } from "../pricing/types.js";
import type { PricingBreakdown } from "../pricing/decomposer-types.js";
import { countAutoFixable } from "./fix-command-resolver.js";
import { formatDesiredState } from "./display-helpers/format-desired-state.js";
import type { RenderableState } from "./display-helpers/renderable-state.js";
// NOTE: display.ts re-exports from this module, creating a circular reference.
// This is safe because: (1) RenderableState is type-only (erased at runtime),
// (2) formatDesiredState is defined directly in display.ts (not re-exported from
// another sub-module), so it is available by the time any function here executes.
import {
  formatFindings,
  formatFreeTierNote,
  formatMemoryHints,
  formatAdviceHints,
} from "./display-findings.js";
import { stopSpinner } from "./display-output/spinner.js";

/** Returns the region label for the plan box.
 *  Cross-regional inference profiles (us.*, eu.*, ap.*) are annotated. */
export function regionLabel(): string {
  const crossRegionalPrefix = BEDROCK_MODEL_ID.match(/^(us|eu|ap)\./)?.[1];
  return crossRegionalPrefix
    ? `${AWS_REGION} (cross-regional inference: ${crossRegionalPrefix}.*)`
    : AWS_REGION;
}

/**
 * Formats the estimated cost display. When a pricing breakdown is available
 * (from decomposer), it is rendered separately. This function returns
 * the base estimate label from Pricing MCP (no hardcoded rates), with a
 * source-provenance suffix appended when known (Story 46.2).
 *
 * Examples:
 *   - `formatCostLine("~$32.85/mo", "mcp")`      → `"~$32.85/mo (live)"`
 *   - `formatCostLine("~$32/mo",    "fallback")` → `"~$32/mo (estimated)"`
 *   - `formatCostLine("Free",       "free")`     → `"Free"` (no suffix)
 *   - `formatCostLine(undefined, "mcp")`          → `"N/A"` (no suffix —
 *      "(live)" on a missing value is contradictory; flagged by the
 *      adversarial review F7)
 *   - `formatCostLine(undefined)`                  → `"N/A"`
 *
 * @see Story 23.5 — zero hardcoded dollar amounts
 * @see Story 46.2 — source attribution
 */
export function formatCostLine(
  estimatedMonthlyCost: string | undefined,
  source?: DataSource,
): string {
  // Missing cost → "N/A" with no suffix. The provenance only applies to
  // a real dollar amount; "(live)" tagged onto "N/A" misleads users into
  // thinking the system fetched something authoritative.
  if (estimatedMonthlyCost === undefined) return CostEstimateLabel.NA;
  if (source === undefined) return estimatedMonthlyCost;
  return formatLabelWithSource(estimatedMonthlyCost, source);
}

export function renderPlanBox(state: RenderableState): void {
  stopSpinner();

  // Story 22.3: Auto-fixed best practice findings
  const appliedFixesLine = formatAppliedFixes(state.appliedFixes);

  // Story 18.10: Unified findings section (merged guardrails + best practices)
  const findingsLine = formatFindings(state.bpFindings);

  // Story 7.8: Free tier note line (optional, non-blocking)
  const freeTierLine = formatFreeTierNote(state.freeTierNote);

  // Story 19.3: Memory hints from provision history (optional)
  const memoryHintLines = formatMemoryHints(state.memoryHints);

  // Story 40.3: Inline contextual advice hints (optional)
  const adviceLines = formatAdviceHints(state.adviceHints);

  const configBlock = state.desiredState
    ? formatDesiredState(state.desiredState, state.resourceType)
    : "(none)";

  // Story 23.5: Cost from Pricing MCP (no hardcoded rates)
  // Story 46.2: source-provenance suffix appended when present
  const costLine = formatCostLine(
    state.estimatedMonthlyCost,
    state.estimatedMonthlyCostSource,
  );

  // Story 23.6: Pricing breakdown from decomposers (if available)
  const breakdownLines = state.pricingBreakdown
    ? formatPricingBreakdown(state.pricingBreakdown)
    : null;

  const autoFixHintLine = formatAutoFixHint(state);

  // Story 37.1: source files line
  let sourceFilesLine: string | null = null;
  if (state.sourceDir) {
    const fileCount =
      state.sourceFileCount ?? countFilesRecursive(state.sourceDir);
    sourceFilesLine = `Source files:    ${fileCount} file${fileCount === 1 ? "" : "s"} from ${state.sourceDir}`;
  }

  // Tier S #3: for compound plans, render a queue listing block at the
  // top of the plan box so the user sees ALL N resources, not just the
  // first one. Wave 19's original fix added this as a separate prelude
  // ABOVE the boxen frame; integrating it INSIDE gives TTY users one
  // unified frame instead of two unrelated blocks.
  const compoundLines: string[] = [];
  if (state.compoundQueue && state.compoundQueue.resources.length > 0) {
    compoundLines.push(
      `Compound:        ${state.compoundQueue.patternDisplayName} (${state.compoundQueue.resources.length} resources)`,
    );
    for (let i = 0; i < state.compoundQueue.resources.length; i++) {
      const r = state.compoundQueue.resources[i]!;
      const num = String(i + 1).padStart(2, " ");
      const dn = r.displayName ? ` — ${r.displayName}` : "";
      const marker = r.resourceType === state.resourceType ? "▸" : " ";
      compoundLines.push(`  ${marker} ${num}. ${r.resourceType}${dn}`);
    }
    compoundLines.push("");
  }

  // Epic 94 N8 (C-01): companion (non-provisionable) resources render
  // with a `[companion]` tag so users can distinguish the provisionable
  // members of a compound plan from display-only sub-resources (e.g.
  // API Gateway v2 Integration / Route / Stage, Lambda Permission).
  // The companion still carries a full desiredState block — that is
  // the user-visible proof of settings like
  // `ProtocolType: WEBSOCKET` that would otherwise be invisible
  // before `apply`.
  const resourceTypeLine =
    state.provisionable === false
      ? `Resource Type:   [companion] ${state.resourceType}`
      : `Resource Type:   ${state.resourceType}`;

  const content = [
    ...compoundLines,
    resourceTypeLine,
    `Region:          ${regionLabel()}`,
    `Config:`,
    configBlock,
    `Estimated Cost:  ${costLine}`,
    ...(sourceFilesLine ? [sourceFilesLine] : []),
    ...(breakdownLines ? [breakdownLines] : []),
    ...(adviceLines ? [adviceLines] : []),
    ...(freeTierLine ? [freeTierLine] : []),
    ...(memoryHintLines ? [memoryHintLines] : []),
    ...(appliedFixesLine ? [appliedFixesLine] : []),
    findingsLine,
    ...(autoFixHintLine ? [autoFixHintLine] : []),
    ...(state.verbose || process.argv.includes("--verbose")
      ? [`Run ID:          ${state.runId}`]
      : []),
  ].join("\n");

  if (process.stdout.isTTY) {
    process.stdout.write(
      boxen(content, {
        title: "Plan",
        titleAlignment: BoxenAlign.CENTER,
        borderColor: BoxenBorderColor.CYAN,
        padding: 1,
      }) + "\n",
    );
  } else {
    process.stdout.write(`=== Plan ===\n${content}\n============\n`);
  }
}

/**
 * Formats the pricing breakdown for display in the plan box.
 * Shows fixed costs as a table, subtotal, and usage-based per-unit rates.
 *
 * @see Story 23.6
 */
export function formatPricingBreakdown(breakdown: PricingBreakdown): string {
  const lines: string[] = [];
  const isTTY = process.stdout.isTTY;

  if (breakdown.fixedItems.length > 0) {
    // Calculate max label width for alignment
    const maxLabel = Math.max(
      ...breakdown.fixedItems.map((item) => item.lineItem.label.length),
    );

    for (const item of breakdown.fixedItems) {
      const label = item.lineItem.label.padEnd(maxLabel);
      const desc = item.lineItem.description.padEnd(20);
      const price = item.displayPrice;
      lines.push(`  ${label}   ${desc} ${price}`);
    }

    // Separator + subtotal
    lines.push(`  ${"─".repeat(maxLabel + 25)}`);
    const subtotal =
      breakdown.fixedSubtotal > 0
        ? `$${breakdown.fixedSubtotal.toFixed(2)}/mo`
        : CostEstimateLabel.NA;
    lines.push(`  ${"Subtotal (fixed)".padEnd(maxLabel + 20)} ${subtotal}`);
  }

  if (breakdown.usageBasedItems.length > 0) {
    lines.push(``);
    lines.push(`  Usage-based (per-unit rates):`);
    // Available width inside the plan box (boxen adds ~4 chars of padding)
    // A label column of 24 chars + 2-char prefix = 26; remaining ~54 chars for price.
    // Tier-ladder strings can easily exceed 54 chars — wrap to second line when needed.
    const PRICE_COL_WIDTH = 54;
    for (const item of breakdown.usageBasedItems) {
      const price = item.displayPrice;
      const labelStr = item.lineItem.label.padEnd(24);
      if (price.length > PRICE_COL_WIDTH) {
        // Wrap: first line has the label + beginning of the price string
        // up to the last comma before the column limit, then continue on
        // the next line indented to align with the price column start.
        const indent = `  · ${" ".repeat(24)} `;
        // Find a clean break point (after a comma) within PRICE_COL_WIDTH
        const breakAt = price.lastIndexOf(", ", PRICE_COL_WIDTH);
        if (breakAt > 0) {
          const firstPart = price.slice(0, breakAt + 2); // include ", "
          const secondPart = price.slice(breakAt + 2);
          lines.push(`  · ${labelStr} ${firstPart}`);
          lines.push(`${indent}${secondPart}`);
        } else {
          // No comma — emit as-is (rare)
          lines.push(`  · ${labelStr} ${price}`);
        }
      } else {
        lines.push(`  · ${labelStr} ${price}`);
      }
    }
  }

  // Fetched timestamp
  const fetchedNote = isTTY
    ? chalk.dim(`  Prices fetched at ${breakdown.fetchedAt}`)
    : `  Prices fetched at ${breakdown.fetchedAt}`;
  lines.push(fetchedNote);

  // Only emit the warning when there are items that are GENUINELY unavailable
  // (MCP failure, timeout, region not supported). Tiered items that rendered
  // successfully via the tier-ladder path do NOT trigger this warning.
  const hasGenuinelyUnavailable = breakdown.hasPartialFailure;
  if (hasGenuinelyUnavailable) {
    const warning = isTTY
      ? chalk.yellow(`  ⚠ Some prices unavailable`)
      : `  ⚠ Some prices unavailable`;
    lines.push(warning);
  }

  return lines.join("\n");
}

/**
 * Formats auto-fixed best practice items for display in the plan box.
 * Returns null if no fixes were applied.
 *
 * @see Story 22.3
 */
export function formatAppliedFixes(
  fixes: AppliedFix[] | undefined,
): string | null {
  if (!fixes || fixes.length === 0) return null;
  const isTTY = process.stdout.isTTY;

  const header = `Auto-fixed:      ${fixes.length} fix${fixes.length === 1 ? "" : "es"} applied`;
  const lines = fixes.map((f) => {
    // Item 4a (2026-04-09): surface the BP rule ID so users can `grep`
    // the practiceId in the best-practices YAML library or in docs
    // and understand *why* their wizard input was changed mid-plan.
    const detail = `  \u2713 ${f.fieldPath}: ${formatFixValue(f.oldValue)} \u2192 ${formatFixValue(f.newValue)} (${f.practiceId}: ${f.title})`;
    return isTTY ? chalk.green(detail) : detail;
  });

  return [header, ...lines].join("\n");
}

export function formatFixValue(value: unknown): string {
  if (value === undefined || value === null) return "unset";
  if (typeof value === "boolean") return value ? "enabled" : "disabled";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Story 35.6: Show hint when auto-fix is disabled but auto-fixable findings exist.
 * Returns null when auto-fix is enabled or no auto-fixable findings remain.
 */
export function formatAutoFixHint(state: RenderableState): string | null {
  if (state.autoFixEnabled) return null;
  const items = state.bpFindings ?? [];
  if (items.length === 0) return null;

  const autoFixCount = countAutoFixable(items);
  if (autoFixCount === 0) return null;

  const isTTY = process.stdout.isTTY;
  const msg = `${autoFixCount} finding${autoFixCount === 1 ? "" : "s"} can be auto-fixed. Run \`assignee init\` to enable.`;
  return isTTY ? chalk.cyan(`  \u{1F4A1} ${msg}`) : `  * ${msg}`;
}

/**
 * Epic 92 Wave 2.c — A-02 / D-29: single source of truth for the
 * `--output json` envelope shape consumers rely on.
 *
 * The existing formatter at
 * `graph/nodes/result-formatter/formatters/plan.ts` emits one
 * JSON object per resource when a compound plan runs — that's
 * NDJSON, not parseable JSON. We buffer those payloads at the CLI
 * layer and the CLI calls the helpers below to serialise a
 * single parseable envelope.
 *
 * Three shapes:
 *
 *   single-resource success:
 *     { ok: true, plan: <payload> }
 *   compound success:
 *     { ok: true, plans: [<payload>, <payload>, ...] }
 *   any error:
 *     { ok: false, error: { code, message, hint? } }
 *
 * The helpers are pure — no I/O. CLI `plan.ts` / `list.ts` do the
 * `process.stdout.write(... + "\n")` themselves.
 */
/**
 * `error.detail` payload surfaced in the `--json` envelope. Open-ended
 * key/value bag, narrowed where the CLI has a stable contract:
 *   - Epic 98 e98.W5.N4 (B-04): `errorMessage` carries the concrete
 *     provisioning error (truncated to 500 chars) so automation can
 *     distinguish AWS errors like "Invalid id" from plumbing failures
 *     without parsing JSON-lines stderr.
 *   - Epic 98 e98.W5.N4 (B-05): `practiceIds` carries the blocking
 *     BP practice IDs when `error.code === "BP_BLOCKED"`.
 */
export interface JsonErrorDetail {
  /** Concrete provisioning error (B-04 closure). Truncated at 500 chars. */
  errorMessage?: string;
  /** Blocking BP practice IDs (B-05 closure). Non-empty when present. */
  practiceIds?: string[];
  /** Forward-compat: additional keys tolerated without schema churn. */
  [key: string]: unknown;
}

export interface JsonErrorEnvelope {
  ok: false;
  error: {
    code: string;
    message: string;
    hint?: string;
    detail?: JsonErrorDetail;
  };
}

export interface JsonSuccessEnvelope {
  ok: true;
  plan?: unknown;
  plans?: unknown[];
}

/**
 * Parse a string that might be an NDJSON stream (newline-separated
 * JSON objects) and return the parsed top-level objects. Returns an
 * empty array when the input is empty or not parseable. Used by the
 * CLI stdout interceptor to aggregate per-resource payloads written
 * by `formatters/plan.ts` (owned by Wave 4.a — not editable here).
 */
export function parsePlanJsonStream(buffered: string): unknown[] {
  if (!buffered) return [];
  const out: unknown[] = [];
  // The formatter writes `JSON.stringify(..., null, 2) + "\n"` per
  // resource. Each payload is a JSON object spanning multiple lines.
  // Primary strategy: walk char-by-char, honoring string boundaries,
  // and capture each balanced `{...}` at depth 0.
  //
  // Recovery: if a stray unmatched `{` earlier in the buffer skews the
  // depth counter, we never reach depth 0 again and lose every
  // subsequent payload. To guard against that we ALSO record every
  // newline-anchored `{` as a candidate recovery boundary and, at the
  // end of the primary pass, retry parsing from each anchor that did
  // not already produce a value. This recovers truncated-first /
  // complete-second streams without weakening the happy-path parser.
  let depth = 0;
  let start = 0;
  let inString = false;
  let escape = false;
  const anchors: number[] = [];
  for (let i = 0; i < buffered.length; i++) {
    const ch = buffered[i];
    // Record newline-anchored `{` boundaries before string/escape handling
    // so we see them even when nested inside a depth-skewed context.
    if (!inString && ch === "{" && (i === 0 || buffered[i - 1] === "\n")) {
      anchors.push(i);
    }
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0) {
        const slice = buffered.slice(start, i + 1);
        try {
          out.push(JSON.parse(slice));
        } catch {
          // Fall through to the newline-anchored recovery below.
        }
      }
    }
  }
  if (out.length === 0 && anchors.length > 0) {
    for (const anchor of anchors) {
      const tail = buffered.slice(anchor);
      let d = 0;
      let s = false;
      let esc = false;
      let end = -1;
      for (let j = 0; j < tail.length; j++) {
        const c = tail[j];
        if (esc) {
          esc = false;
          continue;
        }
        if (c === "\\" && s) {
          esc = true;
          continue;
        }
        if (c === '"') {
          s = !s;
          continue;
        }
        if (s) continue;
        if (c === "{") d++;
        else if (c === "}") {
          d--;
          if (d === 0) {
            end = j;
            break;
          }
        }
      }
      if (end >= 0) {
        try {
          out.push(JSON.parse(tail.slice(0, end + 1)));
        } catch {
          // Skip — not every anchor is a valid payload.
        }
      }
    }
  }
  return out;
}

/**
 * Serialise an array of plan payloads (one per resource) as a single
 * top-level envelope. Compound → `{ ok, plans: [...] }`; single →
 * `{ ok, plan: <payload> }`. Deterministic 2-space indentation
 * matches the existing formatter output for side-by-side diff review.
 */
export function serializePlanEnvelope(payloads: unknown[]): string {
  const envelope: JsonSuccessEnvelope =
    payloads.length === 1
      ? { ok: true, plan: payloads[0] }
      : { ok: true, plans: payloads };
  return JSON.stringify(envelope, null, 2) + "\n";
}

/**
 * Serialise a failure envelope. Code/message required; hint + detail optional.
 *
 * Epic 98 e98.W5.N4 (B-04 + B-05): `detail` is an optional structured
 * bag. It's emitted only when at least one of its known fields is set
 * so the existing stable shape stays unchanged for callers that don't
 * opt in. Callers that opt in (apply.ts JSON error path) pass either
 * `{ errorMessage }` (B-04) or `{ practiceIds }` (B-05) or both.
 */
export function serializeErrorEnvelope(
  code: string,
  message: string,
  hint?: string,
  detail?: JsonErrorDetail,
): string {
  const error: JsonErrorEnvelope["error"] = { code, message };
  if (hint !== undefined) error.hint = hint;
  if (detail !== undefined && hasDefinedKeys(detail)) error.detail = detail;
  const envelope: JsonErrorEnvelope = { ok: false, error };
  return JSON.stringify(envelope, null, 2) + "\n";
}

/**
 * `true` when the detail object has at least one key whose value is
 * defined. Keeps `error.detail` from serialising as `{}` when all
 * fields on the passed-in detail are undefined — a common shape from
 * `{errorMessage: maybeUndef, practiceIds: maybeEmpty}` construction.
 */
function hasDefinedKeys(obj: JsonErrorDetail): boolean {
  for (const value of Object.values(obj)) {
    if (value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    return true;
  }
  return false;
}

/**
 * Story 37.1: Recursively count files in a directory.
 * Used by renderPlanBox to display the source file count.
 */
function countFilesRecursive(dir: string, maxDepth = 20): number {
  if (maxDepth <= 0) return 0;
  try {
    let count = 0;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        count += countFilesRecursive(path.join(dir, entry.name), maxDepth - 1);
      } else {
        count++;
      }
    }
    return count;
  } catch {
    return 0;
  }
}
