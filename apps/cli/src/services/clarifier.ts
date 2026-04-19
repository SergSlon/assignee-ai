/**
 * NL-intent clarifier — Story 52-1 (closes Epic-51 L2-H4).
 *
 * When plan/apply fails because the LLM couldn't map the user's intent to
 * a supported resource type, this service prompts the operator for ONE
 * focused clarification and returns a re-formed intent for a single
 * retry. TTY-only, opt-out respected.
 *
 * Bypass conditions (return null without prompting):
 *   - `!process.stdin.isTTY` → CI / redirected stdin.
 *   - `--yes` or `--quick` flags set on the invoking command.
 *   - Failure mode is not intent-ambiguity (e.g. Bedrock region mismatch).
 */

import * as clack from "@clack/prompts";
import { ExecutionStatus, renderClarifierExampleList } from "@assignee/core";
import type { AgentState } from "./graph-state.js";

/** Inputs the clarifier needs from the caller. */
export interface ClarifierInput {
  /** Terminal graph state from the failed run. */
  state: AgentState;
  /** Whether `--yes` was passed (skip prompting entirely). */
  autoApprove: boolean;
  /** Whether `--quick` was passed (skip prompting entirely). */
  quick: boolean;
  /** Override for TTY detection — tests pass `false` to simulate non-TTY. */
  isTty?: boolean;
}

/**
 * Derive a targeted clarifying question from the failure context.
 *
 * We lean on the ORIGINAL user intent plus the failure's `errorMessage` so
 * the question names the actual ambiguity rather than asking "please
 * clarify". If the LLM surfaced an `errorMessage`, we quote it back; if
 * not, we fall back to the intent text and ask the user to name the AWS
 * resource type explicitly.
 */
export function buildClarifyingQuestion(state: AgentState): string {
  const intent = (state.userIntent ?? "").trim();
  const err = (state.errorMessage ?? "").trim();

  // Story 56-it2-04 L3-L3: beginner example list is rendered from the
  // help-hints SSO module instead of duplicating a literal inline —
  // adding/renaming an example now happens in one place.
  const examples = renderClarifierExampleList();
  if (err && intent) {
    return `I couldn't map "${intent}" to a supported AWS resource (${err}). Could you rephrase — for example, name the specific AWS resource type (${examples})?`;
  }
  if (intent) {
    return `I couldn't map "${intent}" to a supported AWS resource. Could you rephrase — for example, name the specific AWS resource type you'd like to create?`;
  }
  return `I couldn't determine a resource type from your intent. Could you describe what you want, naming the specific AWS resource type (${examples})?`;
}

/**
 * Whether the failure looks like an "LLM couldn't map intent" ambiguity
 * (the case the clarifier can actually help with). We skip for everything
 * else — credential failures, region mismatches, policy blocks, etc.
 * should surface the existing error immediately.
 */
export function isClarifiableFailure(state: AgentState): boolean {
  if (state.executionStatus === ExecutionStatus.UNSUPPORTED_RESOURCE)
    return true;
  if (state.executionStatus !== ExecutionStatus.FAILED) return false;
  // FAILED is a catch-all; we only clarify if the plan/intent pipeline
  // didn't yield a resource type (i.e. the ambiguity is at the intent
  // layer, not downstream).
  return !state.resourceType;
}

/**
 * Prompt the operator for a clarifying rephrase. Returns the new intent
 * string, or `null` if the clarifier is bypassed / the user aborts.
 */
export async function askClarifyingQuestion(
  input: ClarifierInput,
): Promise<string | null> {
  const { state, autoApprove, quick } = input;
  const isTty = input.isTty ?? Boolean(process.stdin.isTTY);

  // ── Bypass conditions ────────────────────────────────────────────────
  if (!isTty) return null;
  if (autoApprove || quick) return null;
  // Story 56-it2-04 L3-L1: ASSIGNEE_NO_CLARIFIER=1 skips the prompt
  // entirely. Mirrors ASSIGNEE_NO_UPDATE_CHECK — opt-out for users who
  // want the original error surface restored without passing --yes /
  // --quick (e.g. long-running automation pipelines).
  if (process.env["ASSIGNEE_NO_CLARIFIER"] === "1") return null;
  if (!isClarifiableFailure(state)) return null;

  const question = buildClarifyingQuestion(state);

  const answer = await clack.text({
    message: question,
    placeholder: "rephrase here, or press Enter to abort",
  });

  // Ctrl-C, empty, or literal "cancel" → null (fall back to existing error).
  if (clack.isCancel(answer)) return null;
  const trimmed = (answer ?? "").toString().trim();
  if (trimmed === "" || trimmed.toLowerCase() === "cancel") return null;

  return trimmed;
}
