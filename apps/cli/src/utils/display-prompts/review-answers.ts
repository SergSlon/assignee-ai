/**
 * Review-answers UI for mid-wizard answer inspection and edit-by-index.
 *
 * Rendered when the user picks "Review answers so far" from an action menu.
 * Returns either:
 *   - { action: "edit", fieldIndex }  — caller (runPromptLoop) re-prompts
 *                                        `fields[fieldIndex]` and re-walks the
 *                                        remaining tier from that slot so
 *                                        downstream showIf branches re-evaluate.
 *   - { action: "cancel" }             — caller re-shows the originating prompt
 *                                        unchanged (byte-identical no-op).
 *
 * Sensitive-field masking: fields whose `question.sensitive === true` OR whose
 * name matches the SENSITIVE_FIELDS set or `/password|secret|token|key$/i` are
 * rendered as `***` — the raw value MUST NOT appear in the review list.
 *
 * @see Story 48.7
 */
import * as clack from "@clack/prompts";
import type { ResourceField } from "@assignee/core";
import { SENSITIVE_FIELDS } from "../display-helpers/sensitive-fields.js";

const CANCEL_VALUE = "__cancel__" as const;

/** Detects a field that must be masked in plaintext UI. */
function isSensitiveField(field: ResourceField): boolean {
  const q = field.question as typeof field.question & { sensitive?: boolean };
  if (q.sensitive === true) return true;
  if (SENSITIVE_FIELDS.has(field.name)) return true;
  return /password|secret|token|key$/i.test(field.name);
}

/** Human-readable formatting of an already-answered value. */
function formatAnswerValue(field: ResourceField, value: unknown): string {
  if (isSensitiveField(field)) return "***";
  if (value === undefined || value === null || value === "") return "<not set>";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (Array.isArray(value)) {
    if (value.length === 0) return "<not set>";
    return value.map((v) => String(v)).join(", ");
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

export interface ReviewAnswersParams {
  fields: ResourceField[];
  elicitedOptions: Record<string, unknown>;
}

export type ReviewAnswersResult =
  | { action: "edit"; fieldIndex: number }
  | { action: "cancel" };

/**
 * Render a numbered list of (label: value) rows for every answered field
 * and let the user pick one to edit, or cancel back to the current prompt.
 *
 * Preserves the order fields appear in `fields[]` (which is the order the
 * user was asked the questions) so the UI mirrors wizard flow intuitively.
 */
export async function runReviewAnswers(
  params: ReviewAnswersParams,
): Promise<ReviewAnswersResult> {
  const { fields, elicitedOptions } = params;

  // Preserve original field ordering — filter to fields that have an answer.
  const answered: Array<{ field: ResourceField; fieldIndex: number }> = [];
  for (let idx = 0; idx < fields.length; idx++) {
    const f = fields[idx]!;
    if (Object.prototype.hasOwnProperty.call(elicitedOptions, f.name)) {
      const v = elicitedOptions[f.name];
      if (v !== undefined) {
        answered.push({ field: f, fieldIndex: idx });
      }
    }
  }

  // Zero answers — no-op, return cancel so the caller re-shows current prompt.
  if (answered.length === 0) {
    return { action: "cancel" };
  }

  const options = answered.map((row, i) => ({
    value: String(i),
    label: `${i + 1}. ${row.field.question.label}: ${formatAnswerValue(
      row.field,
      elicitedOptions[row.field.name],
    )}`,
  }));
  options.push({
    value: CANCEL_VALUE,
    label: "Cancel \u2014 return to current step",
  });

  const pick = await clack.select({
    message: "Review answers so far \u2014 pick one to edit",
    options,
  });

  if (clack.isCancel(pick) || pick === CANCEL_VALUE) {
    return { action: "cancel" };
  }

  const pickedIdx = Number(pick);
  const row = answered[pickedIdx];
  if (!row) return { action: "cancel" };
  return { action: "edit", fieldIndex: row.fieldIndex };
}
