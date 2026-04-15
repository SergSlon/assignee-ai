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
import { BACK_SENTINEL } from "../../utils/display.js";
import { FieldPolicy } from "../../constants/field-policy.js";
import {
  fieldFetchKey,
  evaluateShowIf,
  promptWithHelp,
} from "../../utils/wizard-helpers.js";

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
        // Clean up showIf-dependent values that depended on the reverted field
        for (const f of fields) {
          if (f.question.showIf?.field === prevField.name) {
            delete elicitedOptions[f.name];
          }
        }
        i = prevIndex;
        if (visibleIndex > 0) visibleIndex--;
      }
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
