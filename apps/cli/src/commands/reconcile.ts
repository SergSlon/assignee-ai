/**
 * `assignee reconcile` command — reconciles drifted resources back to desired state.
 *
 * For each drifted resource: (a) reconcile to desired, (b) accept current as new desired, (c) skip.
 * Supports --dry-run, --auto-reconcile, and --resource filters.
 *
 * @see Story 28.4
 */

import { Command } from "commander";
import chalk from "chalk";
import {
  DriftStatus,
  ChangeType,
  CloudFormationSchemaService,
  adaptDescribeTypeToMcpFormat,
  UserCancelledError,
  type DriftResult,
  type DriftedField,
} from "@assignee/core";
import { CommandName, CommandDescription } from "../constants/commands.js";
import { MemoryService } from "../services/memory.js";
import {
  DriftDetectorService,
  type DriftDetectorOptions,
} from "../services/drift-detector.js";
import type {
  ProvisioningPort,
  ProvisioningPortError,
} from "../services/provisioning-port.js";
import { createDriftDetectorFromEnv } from "../services/drift-detector-factory.js";
import {
  getReconcilePromptFn,
  getReconcileConfirmFn,
} from "./reconcile-factory.js";
import { resolveDesiredState } from "../utils/resolve-desired-state.js";
import {
  ReconcileAction,
  type ReconcileActionType,
} from "../constants/reconcile-actions.js";

// Re-export for consumers (tests, etc.)
export { ReconcileAction, type ReconcileActionType };

/** Summary counters for the reconcile run. */
export interface ReconcileSummary {
  reconciled: number;
  accepted: number;
  skipped: number;
  errors: number;
}

/**
 * Fetch the createOnlyProperties for a CloudFormation resource type.
 * Returns an array of JSON pointer paths (e.g. ["/properties/FunctionName"]).
 */
async function fetchCreateOnlyProperties(
  resourceType: string,
): Promise<string[]> {
  try {
    const service = new CloudFormationSchemaService();
    const rawSchema = await service.getSchema(resourceType);
    const adapted = adaptDescribeTypeToMcpFormat(
      rawSchema as Record<string, unknown>,
    );
    return Array.isArray(adapted.createOnlyProperties)
      ? adapted.createOnlyProperties
      : [];
  } catch {
    return [];
  }
}

/**
 * RFC 6901 escape rules for a JSON Pointer reference token: `~` must be
 * encoded as `~0` and `/` as `~1`. The order matters — `~` must be encoded
 * BEFORE `/` so the resulting `~1` is not double-escaped to `~01`.
 *
 * Exported for unit testing.
 */
export function escapeJsonPointerSegment(segment: string): string {
  return segment.replaceAll("~", "~0").replaceAll("/", "~1");
}

/**
 * Normalise a drifted-field path to the JSON-pointer format used by
 * CloudFormation's createOnlyProperties (e.g. "/properties/FunctionName").
 *
 * Property names containing `/` or `~` (rare but legal in CloudFormation
 * resource schemas) are escaped per RFC 6901 so the resulting pointer is
 * round-trippable.
 *
 * Exported for unit testing.
 */
export function fieldPathToJsonPointer(fieldPath: string): string {
  // Split into segments on `.` (object navigation) and `[index]` (array
  // navigation), escape each segment per RFC 6901, then re-join.
  // Replace bracketed array indices with a leading `.` so a single split
  // pass yields all segments.
  const normalized = fieldPath.replace(/\[(\d+)\]/g, ".$1");
  const segments = normalized.split(".").filter((s) => s.length > 0);
  const escaped = segments.map(escapeJsonPointerSegment);
  return "/" + escaped.join("/");
}

export function fieldPathToSchemaPointer(fieldPath: string): string {
  return "/properties" + fieldPathToJsonPointer(fieldPath);
}

/**
 * Build a JSON Patch (RFC 6902) from drifted fields to restore desired state.
 * If createOnlyProperties are provided, fields that are create-only are excluded
 * from the patch and warnings are emitted.
 */
export function buildPatchDocument(
  driftedFields: DriftedField[],
  createOnlyProperties: string[] = [],
): { ops: object[]; skippedCreateOnly: DriftedField[] } {
  const ops: object[] = [];
  const skippedCreateOnly: DriftedField[] = [];

  for (const field of driftedFields) {
    const jsonPath = fieldPathToJsonPointer(field.path);

    // Check if this field is a create-only (immutable) property
    const schemaPointer = fieldPathToSchemaPointer(field.path);
    if (createOnlyProperties.includes(schemaPointer)) {
      skippedCreateOnly.push(field);
      continue;
    }

    switch (field.changeType) {
      case ChangeType.MODIFIED:
        ops.push({ op: "replace", path: jsonPath, value: field.desiredValue });
        break;
      case ChangeType.REMOVED:
        // Field was removed externally — add it back with desired value
        ops.push({ op: "add", path: jsonPath, value: field.desiredValue });
        break;
      case ChangeType.ADDED_EXTERNALLY:
        // Field was added externally — remove it to restore desired state
        ops.push({ op: "remove", path: jsonPath });
        break;
    }
  }

  return { ops, skippedCreateOnly };
}

/**
 * Prompt function interface for dependency injection in tests.
 */
export type PromptFn = (message: string, choices: string[]) => Promise<string>;

/**
 * Confirm function interface for dependency injection in tests.
 */
export type ConfirmFn = (message: string) => Promise<boolean>;

/**
 * Execute reconcile for a single drifted resource.
 */
export async function reconcileResource(
  result: DriftResult,
  port: ProvisioningPort,
  memory: MemoryService,
  opts: {
    dryRun: boolean;
    autoReconcile: boolean;
    promptFn: PromptFn;
    confirmFn: ConfirmFn;
  },
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

export const reconcileCommand = new Command(CommandName.RECONCILE)
  .description(CommandDescription.RECONCILE)
  .option("--resource <type>", "Filter by resource type")
  .option("--dry-run", "Show what would be reconciled without making changes")
  .option(
    "--auto-reconcile",
    "Reconcile all drifted resources without prompting",
  )
  .action(
    async (opts: {
      resource?: string;
      dryRun?: boolean;
      autoReconcile?: boolean;
    }) => {
      const memory = new MemoryService();
      const provisions = await memory.readProvisions();

      if (provisions.length === 0) {
        process.stdout.write(
          "No managed resources found. Run `assignee plan` and `assignee apply` to provision resources.\n",
        );
        return;
      }

      let filtered = provisions;
      if (opts.resource) {
        filtered = filtered.filter((p) => p.resourceType === opts.resource);
      }

      // Build drift detector from environment credentials via factory
      const detectorResult = createDriftDetectorFromEnv();

      if (!detectorResult) {
        process.stdout.write(
          "Reconcile requires AWS credentials. Configure credentials and try again.\n",
        );
        return;
      }

      const { detector, port: portOrUndefined } = detectorResult;

      // Run drift detection with resolved desiredState (same as drift.ts)
      const results: DriftResult[] = [];
      for (const provision of filtered) {
        const desiredState = await resolveDesiredState(provision.resourceArn);
        const driftResult = await detector.checkResource(
          provision.resourceType,
          provision.resourceArn,
          desiredState,
        );
        results.push(driftResult);
      }

      const drifted = results.filter((r) => r.status === DriftStatus.DRIFTED);

      if (drifted.length === 0) {
        process.stdout.write(
          "All resources are in sync. Nothing to reconcile.\n",
        );
        return;
      }

      // Auto-reconcile warning
      if (opts.autoReconcile && !opts.dryRun) {
        process.stdout.write(
          chalk.yellow(
            `\nWARNING: Auto-reconcile will modify ${drifted.length} resources without confirmation.\nPress Enter to continue or Ctrl+C to abort.\n`,
          ),
        );
        // In non-test environments, wait for Enter
        if (process.stdin.isTTY) {
          await new Promise<void>((resolve) => {
            process.stdin.once("data", () => resolve());
          });
        }
      }

      const summary: ReconcileSummary = {
        reconciled: 0,
        accepted: 0,
        skipped: 0,
        errors: 0,
      };

      // Resolve prompt/confirm via factory module (tests vi.mock the factory)
      const promptFn = getReconcilePromptFn();
      const confirmFn = getReconcileConfirmFn();

      for (const result of drifted) {
        try {
          const action = await reconcileResource(
            result,
            portOrUndefined,
            memory,
            {
              dryRun: opts.dryRun ?? false,
              autoReconcile: opts.autoReconcile ?? false,
              promptFn,
              confirmFn,
            },
          );

          switch (action) {
            case ReconcileAction.RECONCILE:
              summary.reconciled++;
              break;
            case ReconcileAction.ACCEPT:
              summary.accepted++;
              break;
            case ReconcileAction.SKIP:
              summary.skipped++;
              break;
          }
        } catch (err) {
          // Cancellation aborts the loop cleanly instead of being silently
          // counted as an error and continuing.
          // @see SECURITY-AUDIT.md — M-S9
          if (err instanceof UserCancelledError) {
            process.stdout.write(
              chalk.yellow(
                `\nReconcile cancelled by user — aborting remaining resources.\n`,
              ),
            );
            break;
          }
          const message = err instanceof Error ? err.message : String(err);
          process.stdout.write(
            chalk.red(`  Error reconciling ${result.resourceId}: ${message}\n`),
          );
          summary.errors++;
        }
      }

      // Render summary
      process.stdout.write(
        `\nReconciled: ${summary.reconciled}, Accepted: ${summary.accepted}, Skipped: ${summary.skipped}, Errors: ${summary.errors}\n`,
      );
    },
  );
