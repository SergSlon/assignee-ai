/**
 * `assignee destroy` command — safely destroys a managed AWS resource.
 *
 * Resolves resources by ARN or name via the Resource Groups Tagging API,
 * displays resource details and estimated cost savings, then requires the user
 * to type "yes" for confirmation (strict confirmation — not Y/n).
 *
 * Uses CloudControl API DeleteResourceCommand for supported types,
 * SDK fallback for types with known CCAPI gaps (EventSourceMapping, SNS Subscription).
 *
 * @see Story 18.5
 */

import * as clack from "@clack/prompts";
import chalk from "chalk";
import boxen from "boxen";
import { Command } from "commander";
import {
  CCAPI_FALLBACK_TYPES,
  CCAPI_REDIRECT_TYPES,
  RESOURCE_TYPES,
  AssigneeError,
  ConfigurationError,
  UserCancelledError,
} from "@assignee/core";
import {
  CommandName,
  CommandDescription,
  CommandArgs,
} from "../constants/commands.js";
import { getCostSavingsEstimate } from "../services/billing.js";
import { getBillingMcpToolsAsync } from "../services/mcp-client.js";
import { renderError, startSpinner, stopSpinner } from "../utils/display.js";
import { createCloudControlClient } from "../services/cloudcontrol-client.js";
import { CloudControlAdapter } from "../services/cloudcontrol-adapter.js";
import { SDKFallbackDispatcher } from "../services/sdk-fallback-dispatcher.js";
import {
  resolveResource,
  createTaggingClient,
} from "../services/resource-resolver.js";
import { operatorCredentials } from "../config/operator-credentials.js";

/** Maximum number of polls before giving up on delete status. */
const MAX_POLL_ATTEMPTS = 60;
/** Delay between polls in milliseconds. */
const POLL_INTERVAL_MS = 2000;

/**
 * Renders a resource details box before confirmation.
 */
function renderDestroyBox(resource: {
  resourceType: string;
  arn: string;
  region: string;
  identifier: string;
  estimatedMonthlyCost: string;
}): void {
  const content = [
    `Resource Type:   ${resource.resourceType}`,
    `ARN:             ${resource.arn}`,
    `Region:          ${resource.region}`,
    `Identifier:      ${resource.identifier}`,
    `Estimated Cost:  ${resource.estimatedMonthlyCost}`,
  ].join("\n");

  if (process.stdout.isTTY) {
    process.stdout.write(
      boxen(content, {
        title: "Destroy Resource",
        titleAlignment: "center",
        borderColor: "red",
        padding: 1,
      }) + "\n",
    );
  } else {
    process.stdout.write(
      `=== Destroy Resource ===\n${content}\n========================\n`,
    );
  }
}

/**
 * Polls for delete completion using the CloudControlAdapter's getRequestStatus method.
 */
async function pollDeleteStatus(
  adapter: CloudControlAdapter,
  requestToken: string,
): Promise<{ success: boolean; message?: string }> {
  for (let i = 0; i < MAX_POLL_ATTEMPTS; i++) {
    const [err, status] = await adapter.getRequestStatus(requestToken);
    if (err) {
      return { success: false, message: err.message };
    }

    if (status.operationStatus === "SUCCESS") {
      return { success: true };
    }
    if (status.operationStatus === "FAILED") {
      return {
        success: false,
        message: status.statusMessage ?? "Delete operation failed",
      };
    }

    // IN_PROGRESS — wait and poll again
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }

  return { success: false, message: "Delete operation timed out" };
}

/**
 * Displays success message with estimated savings.
 */
function renderDestroySuccess(estimatedMonthlyCost: string): void {
  if (process.stdout.isTTY) {
    process.stdout.write(
      chalk.green(
        `Resource destroyed. Estimated savings: ${estimatedMonthlyCost}\n`,
      ),
    );
  } else {
    process.stdout.write(
      `Resource destroyed. Estimated savings: ${estimatedMonthlyCost}\n`,
    );
  }
}

/**
 * Core action handler for the destroy command.
 * Exported for testability — the Commander wrapper delegates to this.
 */
export async function destroyAction(
  resource: string,
  opts: { yes?: boolean },
): Promise<void> {
  // ── Reject --all explicitly ──────────────────────────────────────────
  if (resource === "--all") {
    throw new AssigneeError(
      "--all is not supported. Destroy resources individually for safety:\n  assignee destroy <resource-arn-or-name>",
      "DESTROY_ERROR",
    );
  }

  // ── Initialize AWS clients ──────────────────────────────────────────
  const awsConfig = operatorCredentials();
  let taggingClient;
  try {
    taggingClient = createTaggingClient(awsConfig);
  } catch {
    throw new ConfigurationError(
      "AWS credentials are not configured. Set ASSIGNEE_OPERATOR_ACCESS_KEY_ID and ASSIGNEE_OPERATOR_SECRET_ACCESS_KEY environment variables, or run `assignee setup`.",
    );
  }

  // ── Resolve resource ────────────────────────────────────────────────
  startSpinner("Resolving resource...");

  const resolved = await resolveResource(
    resource,
    taggingClient,
    awsConfig.region || "us-east-1",
  );

  stopSpinner();

  if (!resolved) {
    throw new AssigneeError(
      `No managed resource found matching "${resource}". Run 'assignee list' to see managed resources.`,
      "DESTROY_ERROR",
    );
  }

  // ── Estimate cost savings (Story 19.7) ──────────────────────────────
  const billingTools = await getBillingMcpToolsAsync();
  const savingsEstimate = await getCostSavingsEstimate(
    resolved.arn,
    billingTools,
  );
  const estimatedMonthlyCost =
    savingsEstimate !== "N/A" ? savingsEstimate : "(cost data unavailable)";

  // ── Display resource details ────────────────────────────────────────
  renderDestroyBox({
    resourceType: resolved.resourceType,
    arn: resolved.arn,
    region: resolved.region,
    identifier: resolved.identifier,
    estimatedMonthlyCost,
  });

  // ── Confirmation prompt ─────────────────────────────────────────────
  if (opts.yes) {
    // --yes flag: auto-confirm
    if (process.stdout.isTTY) {
      process.stderr.write(
        "Warning: --yes flag used in interactive session. Auto-confirming destroy.\n",
      );
    }
  } else {
    // Non-TTY without --yes is an error
    if (!process.stdin.isTTY) {
      throw new AssigneeError(
        "Destroy requires confirmation. Use --yes for non-interactive mode.",
        "DESTROY_ERROR",
      );
    }

    // Strict confirmation: require "yes"
    const answer = await clack.text({
      message: 'Type "yes" to destroy this resource',
    });

    if (clack.isCancel(answer) || answer !== "yes") {
      clack.outro("Destroy cancelled.");
      throw new UserCancelledError("Destroy cancelled.");
    }
  }

  // ── Delete resource ─────────────────────────────────────────────────
  startSpinner("Destroying resource...");

  const resourceType = resolved.resourceType;

  // Check if this is a redirect type (cannot be deleted)
  if (CCAPI_REDIRECT_TYPES[resourceType]) {
    stopSpinner();
    throw new AssigneeError(
      `${resourceType} cannot be deleted through assignee.ai. This resource type requires manual deletion.`,
      "DESTROY_ERROR",
    );
  }

  // Route to SDK fallback for CCAPI gap types and types with known CloudControl issues
  if (
    resourceType === CCAPI_FALLBACK_TYPES.LAMBDA_EVENT_SOURCE_MAPPING ||
    resourceType === CCAPI_FALLBACK_TYPES.SNS_SUBSCRIPTION ||
    resourceType === RESOURCE_TYPES.SNS_TOPIC
  ) {
    try {
      const dispatcher = new SDKFallbackDispatcher(awsConfig);

      let deleteResult;
      if (resourceType === CCAPI_FALLBACK_TYPES.LAMBDA_EVENT_SOURCE_MAPPING) {
        deleteResult = await dispatcher.deleteEventSourceMapping(
          resolved.identifier,
        );
      } else if (resourceType === RESOURCE_TYPES.SNS_TOPIC) {
        // SNS Topic delete via CloudControl fails with invalid TopicArn format.
        // Use native SDK DeleteTopicCommand instead.
        deleteResult = await dispatcher.deleteTopic(resolved.arn);
      } else {
        deleteResult = await dispatcher.unsubscribe(resolved.arn);
      }

      stopSpinner();

      const [deleteErr] = deleteResult;
      if (deleteErr) {
        throw new AssigneeError(
          `Failed to destroy resource: ${deleteErr.message}`,
          "DESTROY_ERROR",
        );
      }

      renderDestroySuccess(estimatedMonthlyCost);
      return;
    } catch (err) {
      stopSpinner();
      if (err instanceof AssigneeError) throw err;
      const message = err instanceof Error ? err.message : String(err);
      throw new AssigneeError(
        `Failed to destroy resource: ${message}`,
        "DESTROY_ERROR",
      );
    }
    return;
  }

  // Pre-delete hooks
  // DynamoDB: disable deletion protection before deleting
  if (resourceType === RESOURCE_TYPES.DYNAMODB_TABLE) {
    try {
      const { DynamoDBClient, UpdateTableCommand } =
        await import("@aws-sdk/client-dynamodb");
      const ddb = new DynamoDBClient({
        region: awsConfig.region ?? "us-east-1",
      });
      await ddb.send(
        new UpdateTableCommand({
          TableName: resolved.identifier,
          DeletionProtectionEnabled: false,
        }),
      );
    } catch {
      // Non-fatal — table may not have protection enabled
    }
  }

  // Default: use CloudControl API
  try {
    const ccClient = createCloudControlClient(awsConfig);
    const adapter = new CloudControlAdapter(ccClient);

    const [deleteErr, deleteResult] = await adapter.deleteResource(
      resourceType,
      resolved.identifier,
    );

    if (deleteErr) {
      stopSpinner();
      throw new AssigneeError(
        `Failed to destroy resource: ${deleteErr.message}`,
        "DESTROY_ERROR",
      );
    }

    // Poll for delete completion
    const pollResult = await pollDeleteStatus(
      adapter,
      deleteResult.requestToken,
    );

    stopSpinner();

    if (!pollResult.success) {
      throw new AssigneeError(
        `Destroy failed: ${pollResult.message}`,
        "DESTROY_ERROR",
      );
    }

    renderDestroySuccess(estimatedMonthlyCost);
  } catch (err) {
    stopSpinner();
    if (err instanceof AssigneeError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new AssigneeError(
      `Failed to destroy resource: ${message}`,
      "DESTROY_ERROR",
    );
  }
}

export const destroyCommand = new Command(CommandName.DESTROY)
  .description(CommandDescription.DESTROY)
  .argument(CommandArgs.RESOURCE.NAME, CommandArgs.RESOURCE.DESC)
  .option(
    "-y, --yes",
    "Auto-confirm destroy without interactive prompt (for CI/CD)",
  )
  .action(destroyAction);
