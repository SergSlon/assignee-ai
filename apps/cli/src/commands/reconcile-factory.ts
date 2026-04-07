/**
 * Factory for reconcile command's interactive prompt/confirm dependencies.
 * Replaces globalThis["__reconcilePromptFn"] / globalThis["__reconcileConfirmFn"]
 * test injection with a proper module that tests can vi.mock.
 *
 * @see Sprint K — Quality Blitz: Fix globalThis DI pattern
 */

import * as clack from "@clack/prompts";
import { UserCancelledError } from "@assignee/core";
import type { PromptFn, ConfirmFn } from "./reconcile.js";

/**
 * Default prompt function backed by @clack/prompts.select.
 *
 * Throws `UserCancelledError` on Ctrl-C / cancel — silently treating it as
 * "Skip" would cause the reconcile loop to keep iterating instead of
 * aborting cleanly.
 *
 * @see SECURITY-AUDIT.md — M-S9
 */
export const defaultPromptFn: PromptFn = async (msg, choices) => {
  const answer = await clack.select({
    message: msg,
    options: choices.map((c) => ({ value: c, label: c })),
  });
  if (clack.isCancel(answer)) {
    throw new UserCancelledError("reconcile prompt cancelled");
  }
  return answer as string;
};

/**
 * Default confirm function backed by @clack/prompts.confirm.
 * Throws `UserCancelledError` on Ctrl-C / cancel for the same reason as
 * `defaultPromptFn`.
 *
 * @see SECURITY-AUDIT.md — M-S9
 */
export const defaultConfirmFn: ConfirmFn = async (msg) => {
  const answer = await clack.confirm({ message: msg });
  if (clack.isCancel(answer)) {
    throw new UserCancelledError("reconcile confirm cancelled");
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
