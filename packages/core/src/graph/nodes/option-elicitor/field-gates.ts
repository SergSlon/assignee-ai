/**
 * Field-gates: pre-prompt policy checks for the wizard prompt-loop.
 *
 * Extracted from prompt-loop.ts while-body (Story 56-it2-03c, L7-002 MED).
 * Encapsulates the skip / inject / advance decisions that run BEFORE the
 * interactive prompt is shown:
 *
 *   - `showIf` unmet → skip field silently (no index advance in visible
 *     progress).
 *   - `NEVER_ASK` policy → inject resolved value silently, count as
 *     `skippedByDefault`, advance to next field.
 *   - `ASK_IF_NOT_SET` policy with value already present → skip silently.
 *   - `quickMode` + usable default → accept default silently, count as
 *     `skippedByDefault`, advance.
 *
 * Returns a discriminated `FieldGateResult` so the caller can decide which
 * loop-state mutations apply. All functions are pure w.r.t. the loop
 * scaffolding (history / visibleIndex / total) — they only mutate
 * `elicitedOptions` for the NEVER_ASK / quickMode injection cases, and
 * the caller increments its own counters.
 */

import type { ResourceField, ResolvedFieldConfig } from "@/index.js";
import { FieldPolicy } from "@/constants/field-policy.js";
import { evaluateShowIf, fieldFetchKey } from "@/utils/wizard-helpers.js";

/**
 * Result of applying the pre-prompt gates for a single field.
 *
 *   - `skip`               — gate skipped the field (showIf unmet or
 *                            ASK_IF_NOT_SET with value present). Caller
 *                            should `i++` and `continue`; no counters move.
 *   - `silent-default`     — value was injected (NEVER_ASK or quickMode).
 *                            Caller should bump `skippedByDefault`, `i++`,
 *                            and `continue`. `elicitedOptions` already
 *                            mutated in place.
 *   - `proceed`            — all gates passed; caller should render the
 *                            interactive prompt for this field.
 */
export type FieldGateResult =
  | { kind: "skip" }
  | { kind: "silent-default" }
  | { kind: "proceed" };

/**
 * Story 50-2: a field has a usable default if the resolved-config value
 * is set OR the field carries an `initialValue` on the question shape.
 * `--set key=value` pre-fills and config-derived values both populate
 * `resolved.value`; plugin-level `initialValue` lives on the question.
 */
export function hasUsableDefault(
  field: ResourceField,
  res: ResolvedFieldConfig,
  elicitedOptions: Record<string, unknown>,
): boolean {
  if (elicitedOptions[field.name] !== undefined) return true;
  if (res.value !== undefined) return true;
  if (field.question.initialValue !== undefined) return true;
  return false;
}

/**
 * Apply pre-prompt gates to a single field. Mutates `elicitedOptions`
 * in place for silent-default cases. Returns a `FieldGateResult` the
 * caller uses to decide whether to advance silently or render the
 * interactive prompt.
 *
 * @param field           — current field under consideration.
 * @param res             — resolved config (policy + value) for the field.
 * @param elicitedOptions — accumulated answers; mutated for silent defaults.
 * @param quickMode       — when true, accept usable defaults silently.
 */
export function applyFieldGates(
  field: ResourceField,
  res: ResolvedFieldConfig,
  elicitedOptions: Record<string, unknown>,
  quickMode: boolean | undefined,
): FieldGateResult {
  // Gate 1: showIf unmet → skip.
  if (field.question.showIf) {
    if (!evaluateShowIf(field.question.showIf, elicitedOptions)) {
      return { kind: "skip" };
    }
  }

  // Gate 2: NEVER_ASK policy → inject resolved value silently.
  if (res.policy === FieldPolicy.NEVER_ASK) {
    if (res.value !== undefined) {
      elicitedOptions[field.name] = res.value;
    }
    return { kind: "silent-default" };
  }

  // Gate 3: ASK_IF_NOT_SET and value already present → skip.
  if (res.policy === FieldPolicy.ASK_IF_NOT_SET) {
    if (elicitedOptions[field.name] !== undefined) {
      return { kind: "skip" };
    }
  }

  // Gate 4: Story 50-2 quickMode + usable default → accept silently.
  if (quickMode && hasUsableDefault(field, res, elicitedOptions)) {
    if (elicitedOptions[field.name] === undefined) {
      elicitedOptions[field.name] =
        res.value !== undefined ? res.value : field.question.initialValue;
    }
    return { kind: "silent-default" };
  }

  return { kind: "proceed" };
}

/**
 * Count fields currently visible given the elicitedOptions snapshot.
 * NEVER_ASK fields and fields with unmet showIf conditions are excluded.
 * Exposed as a helper because the REVIEW sentinel path recomputes `total`
 * after an in-place edit, and the main while-loop recomputes after each
 * prompted answer (downstream showIf branches may appear/disappear).
 */
export function countVisible(
  fields: ResourceField[],
  resolved: Record<string, ResolvedFieldConfig>,
  elicitedOptions: Record<string, unknown>,
): number {
  return fields.filter((f) => {
    const res = resolved[fieldFetchKey(f)];
    if (!res) return false;
    if (res.policy === FieldPolicy.NEVER_ASK) return false;
    if (
      f.question.showIf &&
      !evaluateShowIf(f.question.showIf, elicitedOptions)
    ) {
      return false;
    }
    return true;
  }).length;
}
