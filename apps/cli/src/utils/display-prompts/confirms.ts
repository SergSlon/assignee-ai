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

export async function renderHitlConfirm(
  state: RenderableState,
): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return false;
  }

  const result = await clack.confirm({
    message: `Apply this plan to create ${state.resourceType}?`,
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
 * Prompts user to apply the plan immediately after display.
 * Non-TTY: returns false (CI-safe — auto-decline).
 * @see Story 10.3, FR-20
 */
export async function renderApplyNowConfirm(
  state: RenderableState,
): Promise<boolean> {
  if (!process.stdin.isTTY) return false;

  // Story 46.2: include the source-provenance suffix. The strategy labels
  // almost always already carry a unit ("~$32.85/mo", "$0.0230/GB-mo",
  // "Free", "N/A"). Dropping the trailing "/mo" avoids "~$32.85/mo/mo".
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
