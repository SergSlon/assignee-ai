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

/** Action chosen for each drifted resource. */
export type ReconcileAction = "reconcile" | "accept" | "skip";

/** Summary counters for the reconcile run. */
export interface ReconcileSummary {
  reconciled: number;
  accepted: number;
  skipped: number;
  errors: number;
}

/**
 * Build a JSON Patch (RFC 6902) from drifted fields to restore desired state.
 */
export function buildPatchDocument(driftedFields: DriftedField[]): object[] {
  const ops: object[] = [];

  for (const field of driftedFields) {
    const jsonPath =
      "/" + field.path.replace(/\./g, "/").replace(/\[(\d+)\]/g, "/$1");

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

  return ops;
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
): Promise<ReconcileAction> {
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
    return "skip";
  }

  let action: ReconcileAction;
  if (autoReconcile) {
    action = "reconcile";
  } else {
    const choice = await promptFn(
      `Action for ${result.resourceType} ${result.resourceId}?`,
      ["Reconcile", "Accept", "Skip"],
    );
    action =
      choice === "Reconcile"
        ? "reconcile"
        : choice === "Accept"
          ? "accept"
          : "skip";
  }

  if (action === "skip") {
    return "skip";
  }

  if (action === "accept") {
    // Update desired state to match actual
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
      }
    }
    process.stdout.write(
      chalk.green(
        `  Accepted current state as new desired for ${result.resourceId}\n`,
      ),
    );
    return "accept";
  }

  // Reconcile — update actual to match desired
  if (!autoReconcile) {
    const confirmed = await confirmFn(
      `Reconcile ${result.resourceType} ${result.resourceId}? This will change ${fieldCount} fields. [y/N]`,
    );
    if (!confirmed) {
      return "skip";
    }
  }

  const patchOps = buildPatchDocument(result.driftedFields);
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
  return "reconcile";
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

      const portOrUndefined = (globalThis as Record<string, unknown>)[
        "__assigneeDriftPort"
      ] as DriftDetectorOptions["provisioningPort"] | undefined;

      if (!portOrUndefined) {
        process.stdout.write(
          "Reconcile requires AWS credentials. Configure credentials and try again.\n",
        );
        return;
      }

      const detector = new DriftDetectorService({
        provisioningPort: portOrUndefined,
      });

      // Run drift detection
      const results: DriftResult[] = [];
      for (const provision of filtered) {
        const driftResult = await detector.checkResource(
          provision.resourceType,
          provision.resourceArn,
          undefined,
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

      // Default prompt/confirm functions (tests inject their own)
      const promptFn: PromptFn = async (_msg, choices) => {
        // In a real CLI, use inquirer/clack. For now, default to Skip.
        return choices[2] ?? "Skip";
      };
      const confirmFn: ConfirmFn = async () => true;

      for (const result of drifted) {
        try {
          const action = await reconcileResource(
            result,
            portOrUndefined,
            memory,
            {
              dryRun: opts.dryRun ?? false,
              autoReconcile: opts.autoReconcile ?? false,
              promptFn:
                ((globalThis as Record<string, unknown>)[
                  "__reconcilePromptFn"
                ] as PromptFn) ?? promptFn,
              confirmFn:
                ((globalThis as Record<string, unknown>)[
                  "__reconcileConfirmFn"
                ] as ConfirmFn) ?? confirmFn,
            },
          );

          switch (action) {
            case "reconcile":
              summary.reconciled++;
              break;
            case "accept":
              summary.accepted++;
              break;
            case "skip":
              summary.skipped++;
              break;
          }
        } catch (err) {
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
