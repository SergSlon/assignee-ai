/**
 * `assignee init` command — optional project-level or global config setup.
 *
 * Without flags: creates `.assignee/config.yaml` in the current project.
 * With `--global`: creates `~/.config/assignee/config.yaml` for user-wide defaults.
 *
 * Auto-detects AWS credentials and region, prompts for confirmation,
 * and writes the config file. The command is entirely optional.
 *
 * Wave-6c F2: decomposed into `init/` sub-modules. This file is now a thin
 * Commander wrapper + re-exports for back-compat with plan/apply/setup and
 * with existing tests that dynamic-import from `./init.js`.
 *
 * @see Story 18.1, ADR-010, Story 27.5
 */

import { Command } from "commander";
import * as clack from "@clack/prompts";
import { CommandName, CommandDescription } from "../constants/commands.js";
import {
  resolveIntroContext,
  formatIntroContext,
} from "./init/intro-context.js";
import { runGlobalInit } from "./init/global-flow.js";
import { runProjectInit } from "./init/project-flow.js";

// ── Re-exports for back-compat (tests + other commands) ────────────────
export {
  resolveIntroContext,
  formatIntroContext,
} from "./init/intro-context.js";
export { detectAvailableRoles } from "./init/credentials-detect.js";
export { promptGlobalConfig } from "./init/global-wizard.js";
export type { ProjectConfig } from "./init/project-config-types.js";

export const initCommand = new Command(CommandName.INIT)
  .description(CommandDescription.INIT)
  .option(
    "--global",
    "Create global user config (~/.config/assignee/config.yaml) instead of project config",
  )
  .addHelpText(
    "after",
    `
Examples:
  $ assignee init
        Create a project config in ./assignee/ (interactive, asks auto-fix mode)
  $ assignee init --global
        Create/update ~/.config/assignee/config.yaml for the current user

The wizard offers three auto-fix modes (ask / apply / skip) that persist
to preferences.auto_fix and control how \`assignee plan\` reacts to best
-practice findings. Re-run \`assignee init\` to change the mode later.
`,
  )
  .action(async (options: { global?: boolean }) => {
    const isGlobal = options.global === true;

    const introCtx = await resolveIntroContext();
    clack.intro(
      (isGlobal
        ? "Assignee.ai — Global User Config Setup"
        : "Assignee.ai — Project Initialization") +
        `  [${formatIntroContext(introCtx)}]`,
    );

    if (isGlobal) {
      await runGlobalInit();
      return;
    }

    await runProjectInit();
  });
