/**
 * Single-resource destroy flow.
 *
 * Wave 2 P1-6 + Wave 5 F3: typed-name confirmation (case-insensitive, trim,
 * trailing-slash strip, full-ARN fallback). See `./typed-confirm.ts`.
 */

import * as clack from "@clack/prompts";
import {
  AssigneeError,
  ConfigurationError,
  UserCancelledError,
  CostEstimateLabel,
} from "@assignee/core";
import { getCostSavingsEstimate } from "../../services/billing.js";
import { getBillingMcpToolsAsync } from "../../services/mcp-client.js";
import { startSpinner, stopSpinner } from "../../utils/display.js";
import {
  resolveResource,
  createTaggingClient,
} from "../../services/resource-resolver.js";
import { operatorCredentials } from "../../config/operator-credentials.js";
import { AWS_REGION, UserMessage } from "../../config/constants.js";
import { ErrorCode } from "../../constants/errors.js";
import { destroySingleResource } from "../../services/destroy-service.js";
import { resourceConfirmationToken } from "./typed-confirm.js";
import { renderDestroyBox, renderDestroySuccess } from "./result-formatter.js";

/** Handles single-resource destroy. `resource` must be set by caller. */
export async function singleDestroyAction(
  resource: string,
  opts: { yes?: boolean },
): Promise<void> {
  // ── Initialize AWS clients ────────────────────────────────────────
  const awsConfig = operatorCredentials();
  let taggingClient;
  try {
    taggingClient = createTaggingClient(awsConfig);
  } catch {
    throw new ConfigurationError(
      "AWS credentials are not configured. Set ASSIGNEE_OPERATOR_ACCESS_KEY_ID and ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY environment variables, or run `assignee setup`.",
    );
  }

  // ── Resolve resource ────────────────────────────────────────────
  startSpinner("Resolving resource...");

  const resolved = await resolveResource(
    resource,
    taggingClient,
    awsConfig.region || AWS_REGION,
  );

  stopSpinner();

  if (!resolved) {
    throw new AssigneeError(
      `No managed resource found matching "${resource}". Run 'assignee list' to see managed resources.`,
      ErrorCode.DESTROY_ERROR,
    );
  }

  // ── Estimate cost savings (Story 19.7) ──────────────────────────
  const billingTools = await getBillingMcpToolsAsync();
  const savingsEstimate = await getCostSavingsEstimate(
    resolved.arn,
    billingTools,
  );
  const estimatedMonthlyCost =
    savingsEstimate !== CostEstimateLabel.NA
      ? savingsEstimate
      : "(cost data unavailable)";

  renderDestroyBox({
    resourceType: resolved.resourceType,
    arn: resolved.arn,
    region: resolved.region,
    identifier: resolved.identifier,
    estimatedMonthlyCost,
  });

  // ── Confirmation prompt ─────────────────────────────────────────
  if (opts.yes) {
    if (process.stdout.isTTY) {
      process.stderr.write(
        "Warning: --yes flag used in interactive session. Auto-confirming destroy.\n",
      );
    }
  } else {
    if (!process.stdin.isTTY) {
      throw new AssigneeError(
        "Destroy requires confirmation. Use --yes for non-interactive mode.",
        ErrorCode.DESTROY_ERROR,
      );
    }

    // Wave-2 P1-6 / Wave 5 F3 typed-name confirm (case-insensitive, trim).
    const confirmToken = resourceConfirmationToken(resolved);
    const answer = await clack.text({
      message: `Type '${confirmToken}' to confirm destruction, or anything else to cancel:`,
    });

    if (
      clack.isCancel(answer) ||
      typeof answer !== "string" ||
      answer.trim().toLowerCase() !== confirmToken.toLowerCase()
    ) {
      clack.outro(UserMessage.DESTROY_CANCELLED);
      throw new UserCancelledError(UserMessage.DESTROY_CANCELLED);
    }
  }

  // ── Delete resource ─────────────────────────────────────────────
  startSpinner("Destroying resource...");

  const result = await destroySingleResource(resolved, {
    region: resolved.region,
  });

  stopSpinner();

  if (!result.success) {
    throw new AssigneeError(
      result.error ??
        `Destroy call returned no error message — the resource may already be gone or AWS accepted the call without confirming. Run \`assignee list\` to verify, and check \`~/.assignee/logs/\` for the full structured trace.`,
      ErrorCode.DESTROY_ERROR,
    );
  }

  renderDestroySuccess(estimatedMonthlyCost);
}
