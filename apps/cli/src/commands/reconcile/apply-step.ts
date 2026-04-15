/**
 * Per-resource reconcile action (apply → AWS CloudControl patch).
 * Wave-6d F4: split out of reconcile.ts.
 */
import chalk from "chalk";
import type { DriftResult } from "@assignee/core";
import { MemoryService } from "../../services/memory.js";
import type { ProvisioningPort } from "../../services/provisioning-port.js";
import {
  ReconcileAction,
  type ReconcileActionType,
} from "../../constants/reconcile-actions.js";
import {
  buildPatchDocument,
  fetchCreateOnlyProperties,
} from "./patch-builder.js";
import type { PromptFn, ConfirmFn } from "./types.js";

export interface ReconcileResourceOpts {
  dryRun: boolean;
  autoReconcile: boolean;
  promptFn: PromptFn;
  confirmFn: ConfirmFn;
}

/**
 * Execute reconcile for a single drifted resource.
 *
 * Returns the action taken (RECONCILE / ACCEPT / SKIP).
 */
export async function reconcileResource(
  result: DriftResult,
  port: ProvisioningPort,
  memory: MemoryService,
  opts: ReconcileResourceOpts,
): Promise<ReconcileActionType> {
  const { dryRun, autoReconcile, promptFn, confirmFn } = opts;
  const fieldCount = result.driftedFields.length;

  // Show drift summary
  process.stdout.write(
    `\n${chalk.bold(result.resourceType)} ${result.resourceId} — ${fieldCount} drifted field(s)\n`,
  );
  for (const f of result.driftedFields) {
    process.stdout.write(
      `  ${f.path}: ${JSON.stringify(f.desiredValue)} → ${JSON.stringify(f.actualValue)}\n`,
    );
  }

  if (dryRun) {
    process.stdout.write(chalk.gray("  [dry-run] Would prompt for action\n"));
    return ReconcileAction.SKIP;
  }

  let action: ReconcileActionType;
  if (autoReconcile) {
    action = ReconcileAction.RECONCILE;
  } else {
    const choice = await promptFn(
      `Action for ${result.resourceType} ${result.resourceId}?`,
      ["Reconcile", "Accept", "Skip"],
    );
    action =
      choice === "Reconcile"
        ? ReconcileAction.RECONCILE
        : choice === "Accept"
          ? ReconcileAction.ACCEPT
          : ReconcileAction.SKIP;
  }

  if (action === ReconcileAction.SKIP) {
    return ReconcileAction.SKIP;
  }

  if (action === ReconcileAction.ACCEPT) {
    // Update desired state to match actual and persist to disk
    if (result.actualState) {
      const provisions = await memory.readProvisions();
      const provision = provisions.find(
        (p) => p.resourceArn === result.resourceId,
      );
      if (provision) {
        provision.desiredStateHash = JSON.stringify(result.actualState).slice(
          0,
          12,
        );
        provision.timestamp = new Date().toISOString();
        await memory.appendProvision(provision);
      }
    }
    process.stdout.write(
      chalk.green(
        `  Accepted current state as new desired for ${result.resourceId}\n`,
      ),
    );
    return ReconcileAction.ACCEPT;
  }

  // Reconcile — update actual to match desired
  if (!autoReconcile) {
    const confirmed = await confirmFn(
      `Reconcile ${result.resourceType} ${result.resourceId}? This will change ${fieldCount} fields. [y/N]`,
    );
    if (!confirmed) {
      return ReconcileAction.SKIP;
    }
  }

  // Fetch create-only properties to prevent destructive updates on immutable fields
  const createOnlyProps = await fetchCreateOnlyProperties(result.resourceType);
  const { ops: patchOps, skippedCreateOnly } = buildPatchDocument(
    result.driftedFields,
    createOnlyProps,
  );

  // Warn about create-only fields that cannot be patched
  for (const skipped of skippedCreateOnly) {
    process.stdout.write(
      chalk.yellow(
        `  WARNING: ${skipped.path} is a create-only (immutable) property — skipped. ` +
          `Use \`assignee plan\` to recreate the resource.\n`,
      ),
    );
  }

  if (patchOps.length === 0) {
    process.stdout.write(
      chalk.gray(
        `  All drifted fields are create-only. Nothing to patch for ${result.resourceId}.\n`,
      ),
    );
    return ReconcileAction.SKIP;
  }

  const patchDocument = JSON.stringify(patchOps);

  const [error] = await port.updateResource(
    result.resourceType,
    result.resourceId,
    patchDocument,
  );

  if (error) {
    throw new Error(error.message);
  }

  process.stdout.write(
    chalk.green(`  Reconciled ${result.resourceId} successfully\n`),
  );
  return ReconcileAction.RECONCILE;
}
