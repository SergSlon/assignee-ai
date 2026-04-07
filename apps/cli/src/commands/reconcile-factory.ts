/**
 * Factory for reconcile command's interactive prompt/confirm dependencies.
 * Replaces globalThis["__reconcilePromptFn"] / globalThis["__reconcileConfirmFn"]
 * test injection with a proper module that tests can vi.mock.
 *
 * @see Sprint K — Quality Blitz: Fix globalThis DI pattern
 */

import * as clack from "@clack/prompts";
import type { PromptFn, ConfirmFn } from "./reconcile.js";

/**
 * Default prompt function backed by @clack/prompts.select.
 * Returns "Skip" if the user cancels.
 */
export const defaultPromptFn: PromptFn = async (msg, choices) => {
  const answer = await clack.select({
    message: msg,
    options: choices.map((c) => ({ value: c, label: c })),
  });
  if (clack.isCancel(answer)) {
    return "Skip";
  }
  return answer as string;
};

/**
 * Default confirm function backed by @clack/prompts.confirm.
 * Returns false if the user cancels.
 */
export const defaultConfirmFn: ConfirmFn = async (msg) => {
  const answer = await clack.confirm({ message: msg });
  if (clack.isCancel(answer)) {
    return false;
  }
  return answer;
};

/**
 * Returns the prompt function the reconcile command should use.
 * Tests vi.mock this module to inject custom behavior.
 */
export function getReconcilePromptFn(): PromptFn {
  return defaultPromptFn;
}

/**
 * Returns the confirm function the reconcile command should use.
 * Tests vi.mock this module to inject custom behavior.
 */
export function getReconcileConfirmFn(): ConfirmFn {
  return defaultConfirmFn;
}
