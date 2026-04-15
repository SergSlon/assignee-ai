/**
 * `assignee reconcile` command — reconciles drifted resources back to desired state.
 *
 * Wave-6d F4: decomposed into `reconcile/` sub-modules. This file is
 * now a thin Commander wrapper + re-export surface so existing
 * consumers (tests, reconcile-factory) keep working.
 *
 * @see Story 28.4
 */

import { Command } from "commander";
import { CommandName, CommandDescription } from "../constants/commands.js";
import {
  ReconcileAction,
  type ReconcileActionType,
} from "../constants/reconcile-actions.js";
import { runReconcile } from "./reconcile/orchestrator.js";
import type { ReconcileOpts } from "./reconcile/types.js";

// ── Re-exports for external consumers (tests, reconcile-factory) ──────────
export { ReconcileAction, type ReconcileActionType };
export type {
  ReconcileSummary,
  PromptFn,
  ConfirmFn,
} from "./reconcile/types.js";
export {
  buildPatchDocument,
  escapeJsonPointerSegment,
  fieldPathToJsonPointer,
  fieldPathToSchemaPointer,
} from "./reconcile/patch-builder.js";
export { reconcileResource } from "./reconcile/apply-step.js";

export const reconcileCommand = new Command(CommandName.RECONCILE)
  .description(CommandDescription.RECONCILE)
  .option("--resource <type>", "Filter by resource type")
  .option("--dry-run", "Show what would be reconciled without making changes")
  .option(
    "--auto-reconcile",
    "Reconcile all drifted resources without prompting",
  )
  .option(
    "-y, --yes",
    "Non-interactive mode — reconcile every drifted resource without prompting (alias for --auto-reconcile; canonical CI flag)",
  )
  .addHelpText(
    "after",
    `
Examples:
  $ assignee reconcile
        Detect drift and prompt per-resource (interactive)
  $ assignee reconcile --dry-run
        Preview reconcile decisions without calling AWS
  $ assignee reconcile --yes
        Reconcile every drifted resource (CI-friendly, same as --auto-reconcile)
  $ assignee reconcile --resource AWS::S3::Bucket --yes
        Reconcile only S3 buckets, non-interactive
`,
  )
  .action(async (opts: ReconcileOpts) => {
    await runReconcile(opts);
  });
