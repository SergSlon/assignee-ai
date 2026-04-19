/**
 * Review-handler: processes the REVIEW_SENTINEL branch of the wizard
 * prompt-loop (Story 48.7 mid-wizard review-answers affordance).
 *
 * Extracted from prompt-loop.ts while-body (Story 56-it2-03c, L7-002 MED).
 *
 * Flow:
 *   1. Open the review UI (`runReviewAnswers`). The user either cancels
 *      or picks a field to edit.
 *   2. Cancel → `{ kind: "reprompt-current" }` — caller re-prompts the
 *      originating slot (byte-identical no-op).
 *   3. Edit → re-prompt the picked field with its current value as the
 *      default. If the user cancels the edit (BACK / REVIEW / empty),
 *      restore the prior answer. Otherwise commit the new answer.
 *   4. In both edit outcomes, truncate the back-stack to the slot BEFORE
 *      the edited field, then return `{ kind: "jump", i: editIdx + 1 }`
 *      so the forward walk re-evaluates every downstream showIf branch.
 *
 * The while-loop's own behaviour (ASK_IF_NOT_SET skip, showIf skip) means
 * already-answered downstream fields are NOT re-prompted — only fields
 * whose answers were cleared by the edit (via BFS cleanup) are re-asked.
 */

import type {
  ResourceField,
  ResolvedFieldConfig,
  LlmPort,
} from "../../../index.js";
import type { StructuredTool } from "@langchain/core/tools";
import {
  BACK_SENTINEL,
  REVIEW_SENTINEL,
  runReviewAnswers,
} from "../../../utils/display.js";
import {
  fieldFetchKey,
  promptWithHelp,
} from "../../../utils/wizard-helpers.js";
import { cleanDependents } from "./back-handler.js";
import { countVisible } from "./field-gates.js";

/**
 * Result of handling a REVIEW_SENTINEL answer.
 *
 *   - `reprompt-current` — caller should `continue` the while-loop
 *                          without mutating `i` / `visibleIndex` (the
 *                          same slot re-prompts).
 *   - `jump`             — caller should adopt the returned `i` /
 *                          `visibleIndex` / `total` and `continue`.
 */
export type ReviewResult =
  | { kind: "reprompt-current" }
  | { kind: "jump"; i: number; visibleIndex: number; total: number };

export interface ReviewHandlerParams {
  fields: ResourceField[];
  resolved: Record<string, ResolvedFieldConfig>;
  elicitedOptions: Record<string, unknown>;
  resourceType: string;
  tools: StructuredTool[];
  llmClient: LlmPort | undefined;
  userIntent: string | undefined;
  /** Mutable back-stack of prior slot indices (truncated on edit). */
  history: number[];
}

/**
 * Handle a REVIEW_SENTINEL answer. Mutates `elicitedOptions` and
 * `history` in place via the review UI; returns a `ReviewResult` telling
 * the caller which loop indices to adopt.
 */
export async function handleReviewSentinel(
  params: ReviewHandlerParams,
): Promise<ReviewResult> {
  const {
    fields,
    resolved,
    elicitedOptions,
    resourceType,
    tools,
    llmClient,
    userIntent,
    history,
  } = params;

  const review = await runReviewAnswers({ fields, elicitedOptions });
  if (review.action === "cancel") {
    // No state mutation — caller re-prompts the same slot.
    return { kind: "reprompt-current" };
  }

  const editIdx = review.fieldIndex;
  const editField = fields[editIdx]!;
  const editRes = resolved[fieldFetchKey(editField)];
  if (!editRes) {
    // Defensive: if the picked field has no resolved config, treat as cancel.
    return { kind: "reprompt-current" };
  }

  // Re-prompt the picked field with current value as default. Build a
  // temporary resolved config with `value` overridden to the current
  // answer so the clack primitive's initialValue reflects what the
  // user already chose.
  const priorAnswer = elicitedOptions[editField.name];
  const editResWithCurrent: ResolvedFieldConfig = {
    ...editRes,
    value: priorAnswer ?? editRes.value,
  };

  // Remove the prior answer + every downstream answer whose showIf
  // depends on the edited field (transitive BFS, mirrors BACK path).
  delete elicitedOptions[editField.name];
  cleanDependents(editField.name, fields, elicitedOptions);

  const newAnswer = await promptWithHelp(
    editField,
    editResWithCurrent,
    resourceType,
    tools,
    llmClient,
    userIntent,
    // showBack:false on the targeted re-prompt — BACK from here means
    // "cancel edit" and is treated as a no-op (we restore prior value).
    false,
    elicitedOptions,
  );

  if (
    newAnswer === BACK_SENTINEL ||
    newAnswer === REVIEW_SENTINEL ||
    newAnswer === undefined ||
    newAnswer === ""
  ) {
    // User cancelled the edit — restore prior answer + re-walk so the
    // rest of the tier is unchanged.
    if (priorAnswer !== undefined) {
      elicitedOptions[editField.name] = priorAnswer;
    }
  } else {
    elicitedOptions[editField.name] = newAnswer;
  }

  // Truncate history to the slot before editIdx and restart the forward
  // walk from editIdx + 1. The while-loop naturally re-evaluates every
  // downstream field's showIf and only re-prompts fields without a value
  // (ASK_IF_NOT_SET skips already-answered fields).
  while (history.length > 0 && history[history.length - 1]! >= editIdx) {
    history.pop();
  }
  const nextI = editIdx + 1;
  const nextTotal = countVisible(fields, resolved, elicitedOptions);
  // Recompute visible position: count visible fields at indices 0..editIdx.
  const nextVisibleIndex = countVisible(
    fields.slice(0, editIdx + 1),
    resolved,
    elicitedOptions,
  );
  return {
    kind: "jump",
    i: nextI,
    visibleIndex: nextVisibleIndex,
    total: nextTotal,
  };
}
