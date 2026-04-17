/**
 * clack.confirm wrappers — HITL, compound HITL, apply-now, advanced.
 * Non-TTY fallback: safe default (decline for HITL, false for advanced/applyNow).
 */
import * as clack from "@clack/prompts";
import {
  UserCancelledError,
  CostEstimateLabel,
  formatLabelWithSource,
  type ArchitecturePattern,
} from "@assignee/core";
import type { RenderableState } from "../display.js";
import { UserMessage } from "../../config/constants.js";

/**
 * Unified plan-approval confirm used on BOTH flows:
 *   - `assignee plan` → "Apply now? ..." (plan orchestrator, before re-entering
 *      graph in APPLY mode with checkpointResumed=true)
 *   - `assignee apply` → "Apply now? ..." (human-approval node, single prompt)
 *
 * Story 50-2: collapsed `renderApplyNowConfirm` and the older
 * `renderHitlConfirm` into a single implementation. The prior
 * two-function split inherited from early HITL scaffolding was
 * confusing: it looked like the user saw two prompts on plan→apply,
 * when in reality `checkpointResumed` already gated the second.
 *
 * The message now always carries resource-type + cost when available
 * (the more informative of the two historical messages), so the user
 * sees the same line regardless of which entry point triggered the
 * confirm. Non-TTY fallback: safe default `false` (declines).
 */
export async function renderHitlConfirm(
  state: RenderableState,
): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return false;
  }

  // Story 46.2: include source-provenance suffix on the cost label when
  // available. Strategy labels already carry a unit ("~$32.85/mo",
  // "$0.0230/GB-mo", "Free", "N/A"), so do not append an extra "/mo".
  const baseLabel = state.estimatedMonthlyCost ?? CostEstimateLabel.NA;
  const costLabel = state.estimatedMonthlyCostSource
    ? formatLabelWithSource(baseLabel, state.estimatedMonthlyCostSource)
    : baseLabel;

  const result = await clack.confirm({
    message: `Apply now? (${state.resourceType}, est. ${costLabel})`,
    initialValue: true,
  });

  if (clack.isCancel(result)) {
    clack.cancel(UserMessage.CANCELLED);
    throw new UserCancelledError();
  }
  return result === true;
}

/**
 * Prompts user to approve a compound multi-resource provisioning plan.
 * Uses the same @clack/prompts confirm() as the single-resource renderHitlConfirm.
 * Non-TTY: safe default is decline.
 */
export async function renderHitlCompoundConfirm(
  pattern: ArchitecturePattern,
  resourceCount: number,
): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return false;
  }

  const result = await clack.confirm({
    message: `Apply this compound plan to provision ${resourceCount} resource${resourceCount === 1 ? "" : "s"} (${pattern.displayName})?`,
    initialValue: true,
  });

  if (clack.isCancel(result)) {
    clack.cancel(UserMessage.CANCELLED);
    throw new UserCancelledError();
  }
  return result === true;
}

/**
 * Prompts user to opt into configuring advanced fields.
 * Non-TTY: returns false (CI-safe).
 */
export async function renderAdvancedConfirm(): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const result = await clack.confirm({
    message:
      "Configure advanced options? (No = secure defaults applied automatically)",
    initialValue: false,
  });
  if (clack.isCancel(result)) {
    clack.cancel(UserMessage.CANCELLED);
    throw new UserCancelledError();
  }
  return result === true;
}

/**
 * Story 50-2: `renderApplyNowConfirm` was collapsed into `renderHitlConfirm`.
 * Kept as a thin alias for external callers/tests until they migrate.
 *
 * @deprecated use `renderHitlConfirm` directly — both entry points now share
 *             the same unified "Apply now? (<type>, est. <cost>)" message.
 * @see Story 10.3, FR-20, Story 50-2
 */
export const renderApplyNowConfirm = renderHitlConfirm;
