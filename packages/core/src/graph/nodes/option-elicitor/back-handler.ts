/**
 * Back-handler: processes the BACK_SENTINEL branch of the wizard prompt-loop.
 *
 * Extracted from prompt-loop.ts while-body (Story 56-it2-03c, L7-002 MED).
 *
 * When the user hits "Back" on a prompt, we:
 *   1. Pop the previous slot off the history stack.
 *   2. Delete the current field's answer (in-flight, never landed).
 *   3. Delete the previous field's answer (user is about to re-pick it).
 *   4. BFS-clean every transitive showIf-dependent answer so downstream
 *      branches re-evaluate correctly on the next iteration.
 *   5. Decrement `visibleIndex` so the progress counter reflects the
 *      step we are moving back to.
 *
 * If history is empty (BACK from the very first field), the handler
 * returns `{ kind: "noop" }` and the caller re-prompts the same slot —
 * this matches the pre-refactor behaviour where the fall-through branch
 * did nothing.
 */

import type { ResourceField } from "../../../index.js";

/**
 * Result of handling a BACK_SENTINEL answer.
 *
 *   - `jump` — caller should set `i = i` and `visibleIndex = visibleIndex`
 *              from the payload, then `continue` the while-loop.
 *   - `noop` — history was empty; caller should `continue` the loop and
 *              re-prompt the same slot (byte-identical no-op).
 */
export type BackResult =
  | { kind: "jump"; i: number; visibleIndex: number }
  | { kind: "noop" };

/**
 * BFS cleanup of transitive showIf dependents. When field A is edited/reverted
 * and B depends on A (B.showIf.field === A.name), B's value is deleted. Then
 * any field C that depends on B is also deleted, and so on.
 */
export function cleanDependents(
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

/**
 * Handle a BACK_SENTINEL answer. Mutates `elicitedOptions` and `history`
 * in place; returns a `BackResult` telling the caller which loop indices
 * to adopt.
 *
 * @param field            — the field whose prompt returned BACK_SENTINEL.
 * @param fields           — full field list (needed for BFS dependents walk).
 * @param elicitedOptions  — accumulated answers; mutated in place.
 * @param history          — mutable stack of prior slot indices.
 * @param visibleIndex     — current visible-progress counter.
 */
export function handleBackSentinel(
  field: ResourceField,
  fields: ResourceField[],
  elicitedOptions: Record<string, unknown>,
  history: number[],
  visibleIndex: number,
): BackResult {
  const prevIndex = history.pop();
  if (prevIndex === undefined) {
    return { kind: "noop" };
  }
  const prevField = fields[prevIndex]!;
  delete elicitedOptions[field.name];
  delete elicitedOptions[prevField.name];
  // Clean up showIf-dependent values transitively (A→B→C chain).
  cleanDependents(prevField.name, fields, elicitedOptions);
  const nextVisibleIndex = visibleIndex > 0 ? visibleIndex - 1 : visibleIndex;
  return { kind: "jump", i: prevIndex, visibleIndex: nextVisibleIndex };
}
