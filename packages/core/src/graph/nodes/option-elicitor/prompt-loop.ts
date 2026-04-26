/**
 * Prompt loop with back-navigation support.
 *
 * Walks over a field tier (common or advanced), honoring:
 *   - showIf conditionals (skip if unmet)
 *   - NEVER_ASK policy (inject value silently)
 *   - ASK_IF_NOT_SET policy (skip if value already set)
 *   - BACK_SENTINEL from promptWithHelp (restore previous visible index,
 *     delete dependent showIf children)
 *   - REVIEW_SENTINEL from promptWithHelp (mid-wizard review-answers UI)
 *
 * Back-nav + review-answers are flagged Wave-4 follow-up — core back-stack
 * implementation lives here and will be extended later.
 *
 * Wave-6c F3: extracted from option-elicitor.ts (SRP).
 * Story 56-it2-03c: split while-body into `field-gates` / `back-handler` /
 * `review-handler` sub-modules so the main loop body is a policy
 * dispatcher (≤ 85 LOC) rather than a 172-LOC monolith.
 */

import * as clack from "@clack/prompts";
import type { ResourceField, ResolvedFieldConfig, LlmPort } from "@/index.js";
import type { StructuredTool } from "@langchain/core/tools";
import { BACK_SENTINEL, REVIEW_SENTINEL } from "@/utils/display.js";
import { fieldFetchKey, promptWithHelp } from "@/utils/wizard-helpers.js";
import { applyFieldGates, countVisible } from "./field-gates.js";
import { handleBackSentinel } from "./back-handler.js";
import { handleReviewSentinel } from "./review-handler.js";

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
  /**
   * Story 50-2: when true, skip every field that has a usable default
   * (resolved.value OR question.initialValue) and silently accept it.
   * Only fields that are required AND have no default produce prompts.
   * Counter-invariants maintained by caller: quickMode does NOT bypass
   * BP auto-fix confirmation (renderPromptFixSelection runs in
   * human-approval AFTER option_elicitor).
   */
  quickMode?: boolean;
}

/**
 * Run one tier of the wizard. Mutates `elicitedOptions` in place.
 * Returns the number of fields that were accepted silently via defaults
 * (either quickMode skip-on-default or NEVER_ASK injection), for the
 * post-wizard summary.
 */
export async function runPromptLoop(
  params: PromptLoopParams,
): Promise<{ skippedByDefault: number; promptedCount: number }> {
  const {
    fields,
    resolved,
    elicitedOptions,
    resourceType,
    tools,
    llmClient,
    userIntent,
    progressLabel,
    quickMode,
  } = params;

  let skippedByDefault = 0;
  let promptedCount = 0;
  const history: number[] = [];
  let total = countVisible(fields, resolved, elicitedOptions);

  let i = 0;
  let visibleIndex = 0;
  while (i < fields.length) {
    const field = fields[i]!;
    const res = resolved[fieldFetchKey(field)];
    if (!res) {
      i++;
      continue;
    }

    const gate = applyFieldGates(field, res, elicitedOptions, quickMode);
    if (gate.kind === "skip") {
      i++;
      continue;
    }
    if (gate.kind === "silent-default") {
      skippedByDefault++;
      i++;
      continue;
    }

    const clampedIndex = Math.min(visibleIndex, total - 1);
    if (process.stdout.isTTY && total > 1) {
      clack.log.info(`${progressLabel} ${clampedIndex + 1} of ${total}`);
    }

    const answer = await promptWithHelp({
      field,
      resolved: res,
      resourceType,
      tools,
      llmClient,
      userIntent,
      showBack: history.length > 0,
      answers: elicitedOptions,
    });

    if (answer === BACK_SENTINEL) {
      const back = handleBackSentinel(
        field,
        fields,
        elicitedOptions,
        history,
        visibleIndex,
      );
      if (back.kind === "jump") {
        i = back.i;
        visibleIndex = back.visibleIndex;
      }
      continue;
    }

    if (answer === REVIEW_SENTINEL) {
      const review = await handleReviewSentinel({
        fields,
        resolved,
        elicitedOptions,
        resourceType,
        tools,
        llmClient,
        userIntent,
        history,
      });
      if (review.kind === "jump") {
        i = review.i;
        visibleIndex = review.visibleIndex;
        total = review.total;
      }
      continue;
    }

    history.push(i);
    if (answer !== undefined && answer !== "") {
      elicitedOptions[field.name] = answer;
    }
    promptedCount++;
    total = countVisible(fields, resolved, elicitedOptions);
    visibleIndex++;
    i++;
  }

  return { skippedByDefault, promptedCount };
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
