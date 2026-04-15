/**
 * `assignee destroy` command — safely destroys managed AWS resources.
 *
 * Single-resource mode: resolves by ARN or name, confirms, deletes.
 * Bulk mode (--all): plans tier-ordered destruction of all managed resources,
 * requires strict confirmation ("destroy all"), and executes sequentially.
 *
 * Wave-6c F2: decomposed into `destroy/` sub-modules. This file is now a
 * thin Commander wrapper + re-exports for back-compat with tests that
 * import `destroyAction` / `resourceConfirmationToken` from here.
 *
 * @see Story 18.5, Story 36.1, Story 36.3
 */

import { Command } from "commander";
import {
  CommandName,
  CommandDescription,
  CommandArgs,
} from "../constants/commands.js";
import { destroyAction } from "./destroy/action.js";

// ── Re-exports for back-compat (tests + callers) ──────────────────────
export { destroyAction } from "./destroy/action.js";
export { resourceConfirmationToken } from "./destroy/typed-confirm.js";

export const destroyCommand = new Command(CommandName.DESTROY)
  .description(CommandDescription.DESTROY)
  .argument("[resource]", CommandArgs.RESOURCE.DESC)
  .option(
    "-y, --yes",
    "Auto-confirm destroy without interactive prompt (for CI/CD)",
  )
  .option("--all", "Destroy all managed resources")
  .option(
    "--include-iam",
    "Include IAM policies/roles (excluded by default with --all)",
  )
  .option("--dry-run", "Show what would be destroyed without doing it")
  .addHelpText(
    "after",
    `
Examples:
  $ assignee destroy arn:aws:s3:::my-bucket
        Destroy a single resource (typed-name confirmation required)
  $ assignee destroy my-bucket --yes
        Non-interactive destroy for CI/CD (skips typed confirmation)
  $ assignee destroy --all --dry-run
        Preview every managed resource that would be destroyed
  $ assignee destroy --all --include-iam --yes
        Sweep every managed resource including IAM roles/policies (CI)

Safety: typed-name confirmation is required for single-resource
destroys without --yes, and the literal phrase "destroy all" is
required for --all (regardless of --yes).
`,
  )
  .action(destroyAction);
