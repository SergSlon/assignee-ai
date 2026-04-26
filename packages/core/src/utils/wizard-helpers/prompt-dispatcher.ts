/**
 * Interactive prompt dispatcher with `?`-help loop and "Other" affordance.
 *
 * Composes three focused handlers under `./prompt-dispatcher/`:
 *   - `handleHelpSentinel` — renders trade-off / doc help on `?`.
 *   - `handleOtherSentinel` — LLM-assisted value flow on "Other".
 *   - Inline BACK / REVIEW propagation — short-circuit sentinels.
 *
 * The loop: render prompt → classify returned sentinel → dispatch or
 * return. Pricing-hint lookup for LLM-suggested values lives in
 * `pricing-hints.ts`; see `prompt-dispatcher/other-handler.ts`.
 *
 * @see Story 49.6 (Epic 49) — decomposed from a 237 LOC / 49-branch god function.
 */

import type {
  LlmPort,
  ResolvedFieldConfig,
  ResourceField,
} from "../../index.js";
import type { StructuredTool } from "@langchain/core/tools";
import {
  renderOptionPrompt,
  BACK_SENTINEL,
  HELP_SENTINEL,
  OTHER_SENTINEL,
  REVIEW_SENTINEL,
} from "../display.js";
import { handleHelpSentinel } from "./prompt-dispatcher/help-handler.js";
import { handleOtherSentinel } from "./prompt-dispatcher/other-handler.js";

/**
 * Options bundle for `promptWithHelp`. Collapses the prior 8 positional
 * parameters into a single object (Story 49.6).
 */
export interface PromptWithHelpOptions {
  field: ResourceField;
  resolved: ResolvedFieldConfig;
  resourceType: string;
  tools: StructuredTool[];
  llmClient?: LlmPort;
  userIntent?: string;
  showBack?: boolean;
  answers?: Record<string, unknown>;
}

function isBack(answer: unknown): boolean {
  return (
    answer === BACK_SENTINEL ||
    (Array.isArray(answer) && answer.includes(BACK_SENTINEL))
  );
}

function isReview(answer: unknown): boolean {
  return (
    answer === REVIEW_SENTINEL ||
    (Array.isArray(answer) && answer.includes(REVIEW_SENTINEL))
  );
}

function isHelp(answer: unknown): boolean {
  return (
    answer === HELP_SENTINEL ||
    (Array.isArray(answer) && answer.includes(HELP_SENTINEL))
  );
}

/**
 * Render a wizard prompt with a `?`-help loop and "Other" support.
 *
 * Back navigation and "Review answers so far?" return their sentinels
 * so the outer prompt loop can restart at a prior step / open the
 * review UI. Cancelled inner prompts throw `UserCancelledError`.
 */
export async function promptWithHelp(
  options: PromptWithHelpOptions,
): Promise<unknown> {
  const opts = options;

  let cachedHint: string | null = null;
  while (true) {
    const promptField = cachedHint
      ? {
          ...opts.field,
          question: { ...opts.field.question, hint: cachedHint },
        }
      : opts.field;

    const answer = await renderOptionPrompt(
      promptField,
      opts.resolved,
      opts.showBack ?? false,
      opts.answers,
    );

    if (isBack(answer)) return BACK_SENTINEL;
    if (isReview(answer)) return REVIEW_SENTINEL;

    if (isHelp(answer)) {
      cachedHint = await handleHelpSentinel({
        field: opts.field,
        resourceType: opts.resourceType,
        tools: opts.tools,
        llmClient: opts.llmClient,
        userIntent: opts.userIntent,
      });
      continue;
    }

    if (answer === OTHER_SENTINEL) {
      const chosen = await handleOtherSentinel({
        field: opts.field,
        resourceType: opts.resourceType,
        tools: opts.tools,
        llmClient: opts.llmClient,
        userIntent: opts.userIntent,
      });
      if (chosen === undefined) continue; // re-prompt
      return chosen;
    }

    return answer;
  }
}
