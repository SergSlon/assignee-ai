/**
 * Assignee CLI program-builder factory.
 *
 * Single source of truth for the Commander.js command tree shape. Three
 * surfaces consume this factory:
 *   1. `apps/cli/src/index.ts` — production runtime (adds version/help text,
 *      preSubcommand hooks, signal handlers, parseAsync).
 *   2. `apps/cli/scripts/generate-completions.ts` — build-time generator that
 *      emits the static `completions/assignee.{zsh,bash,fish}` artifacts.
 *   3. `apps/cli/src/__tests__/commander-tree-snapshot.test.ts` — regression
 *      guard that snapshots the noun-group tree.
 * Plus `apps/cli/src/commands/completions.ts` (runtime `dev completions`) can
 * call the factory directly instead of walking up via `command.parent`.
 *
 * Why one factory: before Story 108-A-05 round 2, the three surfaces each
 * built their own tree. The build-time generator shipped a FLAT 17-leaf tree
 * while the runtime shipped a 3-group noun-grouped tree, causing the bundled
 * completion artifacts to diverge from the live CLI (Quinn BOUNCE BLOCKER #1).
 *
 * This factory builds the noun-group structure (Story 108-A-05 v1.0 freeze):
 *   infra — plan, apply, destroy, drift, reconcile, optimize, restore-provisions
 *   admin — audit-verify, doctor, status, list, describe
 *   dev   — init, setup, update, completions, discover, version
 *
 * Depth-2 `configureHelp({ showGlobalOptions: true })` cascades so global
 * flags (`--verbose` / `--output` / `--json`) appear under every leaf's help.
 *
 * @see Story 108-A-05 (v1.0 API freeze — noun-grouped command tree)
 * @see Story 108-A-05 BOUNCE review at _archive/reviews/c17355be-review.md
 */

import { Command } from "commander";
import { CommandGroup, CommandDescription } from "@assignee/core";

import { planCommand } from "./commands/plan.js";
import { applyCommand } from "./commands/apply.js";
import { completionsCommand } from "./commands/completions.js";
import { initCommand } from "./commands/init.js";
import { describeCommand } from "./commands/describe.js";
import { destroyCommand } from "./commands/destroy.js";
import { driftCommand } from "./commands/drift.js";
import { optimizeCommand } from "./commands/optimize.js";
import { listCommand } from "./commands/list.js";
import { setupCommand } from "./commands/setup.js";
import { statusCommand } from "./commands/status.js";
import { reconcileCommand } from "./commands/reconcile.js";
import { doctorCommand } from "./commands/doctor.js";
import { restoreProvisionsCommand } from "./commands/restore-provisions.js";
import { auditVerifyCommand } from "./commands/audit-verify.js";
import { updateCommand } from "./commands/update.js";
import { versionCommand } from "./commands/version.js";
import { discoverCommand } from "./commands/discover/discover.js";

/**
 * Build the noun-grouped Assignee CLI program tree.
 *
 * The returned Command is a bare-bones `new Command()` with only the noun
 * groups and 18 leaf commands wired in plus depth-2 `configureHelp`
 * cascade. The caller is responsible for adding:
 *   - `.name()` / `.description()` / `.version()` (production-only metadata)
 *   - Global flags (`--verbose` / `--no-color` / `--color`)
 *   - `addHelpText('after', ...)` block (footer hints)
 *   - `hook('preSubcommand', ...)` (chalk reconciliation, ASSIGNEE_LOG_LEVEL)
 *
 * Keeping these out of the factory lets the snapshot test and the completion
 * generator consume the SAME tree shape without picking up runtime side
 * effects (lazy package.json reads, signal handlers, etc.).
 */
export function buildAssigneeProgram(): Command {
  const program = new Command();

  // ── Noun-group parent commands ─────────────────────────────────────────────
  const infraGroup = new Command(CommandGroup.INFRA).description(
    CommandDescription.INFRA,
  );

  const adminGroup = new Command(CommandGroup.ADMIN).description(
    CommandDescription.ADMIN,
  );

  const devGroup = new Command(CommandGroup.DEV).description(
    CommandDescription.DEV,
  );

  // infra group: plan, apply, destroy, drift, reconcile, optimize, restore-provisions
  infraGroup.addCommand(planCommand);
  infraGroup.addCommand(applyCommand);
  infraGroup.addCommand(destroyCommand);
  infraGroup.addCommand(driftCommand);
  infraGroup.addCommand(reconcileCommand);
  infraGroup.addCommand(optimizeCommand);
  infraGroup.addCommand(restoreProvisionsCommand);

  // admin group: audit-verify, doctor, status, list, describe
  adminGroup.addCommand(auditVerifyCommand);
  adminGroup.addCommand(doctorCommand);
  adminGroup.addCommand(statusCommand);
  adminGroup.addCommand(listCommand);
  adminGroup.addCommand(describeCommand);

  // dev group: init, setup, update, completions, discover, version
  devGroup.addCommand(initCommand);
  devGroup.addCommand(setupCommand);
  devGroup.addCommand(updateCommand);
  devGroup.addCommand(completionsCommand);
  devGroup.addCommand(discoverCommand);
  devGroup.addCommand(versionCommand);

  program.addCommand(infraGroup);
  program.addCommand(adminGroup);
  program.addCommand(devGroup);

  // Propagate `showGlobalOptions: true` to every subcommand (depth-2) so the
  // root-level `--verbose` / `--output` / `--json` appear in
  // `<group> <subcommand> --help` output. Commander's configureHelp on the
  // root program does not auto-cascade to sub-subcommands, so we walk two
  // levels: (1) group-level, (2) leaf-level under each group.
  for (const group of program.commands) {
    group.configureHelp({ showGlobalOptions: true });
    for (const leaf of group.commands) {
      leaf.configureHelp({ showGlobalOptions: true });
    }
  }

  return program;
}
