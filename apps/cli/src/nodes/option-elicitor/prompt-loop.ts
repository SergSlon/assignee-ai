/**
 * Prompt loop with back-navigation support.
 *
 * Walks over a field tier (common or advanced), honoring:
 *   - showIf conditionals (skip if unmet)
 *   - NEVER_ASK policy (inject value silently)
 *   - ASK_IF_NOT_SET policy (skip if value already set)
 *   - BACK_SENTINEL from promptWithHelp (restore previous visible index,
 *     delete dependent showIf children)
 *
 * Back-nav + review-answers are flagged Wave-4 follow-up — core back-stack
 * implementation lives here and will be extended later.
 *
 * Wave-6c F3: extracted from option-elicitor.ts (SRP).
 */

import * as clack from "@clack/prompts";
import type {
  ResourceField,
  ResolvedFieldConfig,
  LlmPort,
} from "@assignee/core";
import type { StructuredTool } from "@langchain/core/tools";
import {
  BACK_SENTINEL,
  REVIEW_SENTINEL,
  runReviewAnswers,
} from "../../utils/display.js";
import { FieldPolicy } from "../../constants/field-policy.js";
import {
  fieldFetchKey,
  evaluateShowIf,
  promptWithHelp,
} from "../../utils/wizard-helpers.js";

/**
 * BFS cleanup of transitive showIf dependents. When field A is edited/reverted
 * and B depends on A (B.showIf.field === A.name), B's value is deleted. Then
 * any field C that depends on B is also deleted, and so on.
 */
function cleanDependents(
  rootName: string,
  fields: ResourceField[],
  elicitedOptions: Record<string, unknown>,
): void {
  const queue = [rootName];
  while (queue.length > 0) {
    const parent = queue.shift()!;
    for (const f of fields) {
      if (f.question.showIf?.field === parent && f.name in elicitedOptions) {
        delete elicitedOptions[f.name];
        queue.push(f.name);
      }
    }
  }
}

export interface PromptLoopParams {
  fields: ResourceField[];
  resolved: Record<string, ResolvedFieldConfig>;
  elicitedOptions: Record<string, unknown>;
  resourceType: string;
  tools: StructuredTool[];
  llmClient: LlmPort | undefined;
  userIntent: string | undefined;
  /** Progress label prefix: "Step" for common, "Advanced step" for advanced. */
  progressLabel: string;
}

/** Run one tier of the wizard. Mutates `elicitedOptions` in place. */
export async function runPromptLoop(params: PromptLoopParams): Promise<void> {
  const {
    fields,
    resolved,
    elicitedOptions,
    resourceType,
    tools,
    llmClient,
    userIntent,
    progressLabel,
  } = params;

  const history: number[] = [];

  const countVisible = () =>
    fields.filter((f) => {
      const res = resolved[fieldFetchKey(f)];
      if (!res) return false;
      if (res.policy === FieldPolicy.NEVER_ASK) return false;
      if (
        f.question.showIf &&
        !evaluateShowIf(f.question.showIf, elicitedOptions)
      )
        return false;
      return true;
    }).length;
  let total = countVisible();

  let i = 0;
  let visibleIndex = 0;
  while (i < fields.length) {
    const field = fields[i]!;
    const res = resolved[fieldFetchKey(field)];
    if (!res) {
      i++;
      continue;
    }

    if (field.question.showIf) {
      if (!evaluateShowIf(field.question.showIf, elicitedOptions)) {
        i++;
        continue;
      }
    }

    if (res.policy === FieldPolicy.NEVER_ASK) {
      if (res.value !== undefined) elicitedOptions[field.name] = res.value;
      i++;
      continue;
    }

    if (res.policy === FieldPolicy.ASK_IF_NOT_SET) {
      if (elicitedOptions[field.name] !== undefined) {
        i++;
        continue;
      }
    }

    const clampedIndex = Math.min(visibleIndex, total - 1);
    if (process.stdout.isTTY && total > 1) {
      clack.log.info(`${progressLabel} ${clampedIndex + 1} of ${total}`);
    }

    const answer = await promptWithHelp(
      field,
      res,
      resourceType,
      tools,
      llmClient,
      userIntent,
      history.length > 0,
      elicitedOptions,
    );

    if (answer === BACK_SENTINEL) {
      const prevIndex = history.pop();
      if (prevIndex !== undefined) {
        const prevField = fields[prevIndex]!;
        delete elicitedOptions[field.name];
        delete elicitedOptions[prevField.name];
        // Clean up showIf-dependent values transitively (A→B→C chain).
        cleanDependents(prevField.name, fields, elicitedOptions);
        i = prevIndex;
        if (visibleIndex > 0) visibleIndex--;
      }
      continue;
    }

    // Story 48.7: mid-wizard review-answers affordance.
    // The user picked "Review answers so far" from the current prompt's
    // action menu. Open the review UI, then either cancel (re-show current
    // prompt, byte-identical no-op) or edit-by-index (re-prompt the chosen
    // field with its current value as default, then re-walk the tier from
    // that slot so downstream showIf branches re-evaluate correctly).
    if (answer === REVIEW_SENTINEL) {
      const review = await runReviewAnswers({ fields, elicitedOptions });
      if (review.action === "cancel") {
        // No state mutation — loop iteration re-prompts the same `i`.
        continue;
      }
      const editIdx = review.fieldIndex;
      const editField = fields[editIdx]!;
      const editRes = resolved[fieldFetchKey(editField)];
      if (!editRes) {
        // Defensive: if the picked field has no resolved config, cancel.
        continue;
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
      i = editIdx + 1;
      total = countVisible();
      // Recompute visible position: count visible fields at indices 0..editIdx.
      let vis = 0;
      for (let j = 0; j <= editIdx && j < fields.length; j++) {
        const f = fields[j]!;
        const r = resolved[fieldFetchKey(f)];
        if (!r) continue;
        if (r.policy === FieldPolicy.NEVER_ASK) continue;
        if (
          f.question.showIf &&
          !evaluateShowIf(f.question.showIf, elicitedOptions)
        )
          continue;
        vis++;
      }
      visibleIndex = vis;
      continue;
    }

    history.push(i);
    if (answer !== undefined && answer !== "") {
      elicitedOptions[field.name] = answer;
    }
    total = countVisible();
    visibleIndex++;
    i++;
  }
}

/** Pattern-memory hint (e.g., "(from previous use)") injector factory. */
export function makePatternHintApplier(
  patternHintedFields: Set<string>,
): (field: ResourceField) => ResourceField {
  const patternHint = "(from previous use)";
  return (field: ResourceField): ResourceField => {
    if (!patternHintedFields.has(field.name)) return field;
    const existingHint = field.question.hint;
    return {
      ...field,
      question: {
        ...field.question,
        hint: existingHint ? `${existingHint}\n${patternHint}` : patternHint,
      },
    };
  };
}
