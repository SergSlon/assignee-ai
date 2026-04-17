/**
 * `assignee destroy` command — safely destroys a single managed AWS resource.
 *
 * Single-resource mode only: resolves by ARN or name, confirms, deletes.
 * Story 50-3 cut `--all` and `--include-iam` — bulk destroy was too
 * dangerous for v1 (the safety-allowlist was tacit admission of that).
 * Callers needing to remove many resources invoke destroy per-resource.
 *
 * Wave-6c F2: decomposed into `destroy/` sub-modules. This file is now a
 * thin Commander wrapper + re-exports for back-compat with tests that
 * import `destroyAction` / `resourceConfirmationToken` from here.
 *
 * @see Story 18.5, Story 50-3 (bloat cut)
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
  .argument("<resource>", CommandArgs.RESOURCE.DESC)
  .option(
    "-y, --yes",
    "Auto-confirm destroy without interactive prompt (for CI/CD)",
  )
  .addHelpText(
    "after",
    `
Examples:
  $ assignee destroy arn:aws:s3:::my-bucket
        Destroy a single resource (typed-name confirmation required)
  $ assignee destroy my-bucket --yes
        Non-interactive destroy for CI/CD (skips typed confirmation)

Safety: typed-name confirmation is required for single-resource
destroys without --yes. Bulk destroy (--all) was removed in Story 50-3;
run destroy per-resource instead.
`,
  )
  .action(destroyAction);
